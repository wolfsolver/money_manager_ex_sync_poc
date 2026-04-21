const Database = require('better-sqlite3');
const PocketBase = require('pocketbase/cjs');

// ==========================================
// CONFIGURATION & MAPPING
// ==========================================
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.split('=');
    if (key.startsWith('--')) acc[key.replace('--', '')] = value;
    return acc;
}, {});

const PB_USER = args.user || process.env.PB_USER || 'admin@mmex.it';
const PB_PASS = args.pass || process.env.PB_PASS || 'password123';
const DB_PATH = args.db || process.env.DB_PATH || './sample_db.mmb';
const PB_URL = args.url || process.env.PB_URL || 'http://127.0.0.1:8090';

// Definizione delle tabelle da sincronizzare e dei campi da monitorare per il trigger
const SYNC_CONFIG = {
    'INFOTABLE_V1': { pk: 'INFOID', fields: ['INFONAME', 'INFOVALUE'] },
    'CATEGORY_V1': { pk: 'CATEGID', fields: ['CATEGNAME', 'ACTIVE', 'PARENTID'] },
    'PAYEE_V1': { pk: 'PAYEEID', fields: ['PAYEENAME', 'ACTIVE', 'CATEGID'] },
    'ACCOUNTLIST_V1': { pk: 'ACCOUNTID', fields: ['ACCOUNTNAME', 'STATUS', 'INITIALBAL', 'CURRENCYID'] },
    'CHECKINGACCOUNT_V1': { pk: 'TRANSID', fields: ['ACCOUNTID', 'TOACCOUNTID', 'PAYEEID', 'TRANSCODE', 'TRANSAMOUNT', 'STATUS', 'CATEGID', 'TRANSDATE', 'NOTES'] },
    'BILLSDEPOSITS_V1': { pk: 'BDID', fields: ['ACCOUNTID', 'PAYEEID', 'TRANSCODE', 'TRANSAMOUNT', 'CATEGID', 'NEXTOCCURRENCEDATE'] },
    'BUDGETSPLITTRANSACTIONS_V1': { pk: 'SPLITTRANSID', fields: ['TRANSID', 'CATEGID', 'SPLITTRANSAMOUNT'] }
};

// Ordine di sincronizzazione per rispettare le Foreign Keys
const SYNC_ORDER = [
    'INFOTABLE_V1',
    'CATEGORY_V1',
    'PAYEE_V1',
    'ACCOUNTLIST_V1',
    'CHECKINGACCOUNT_V1',
    'BILLSDEPOSITS_V1',
    'BUDGETSPLITTRANSACTIONS_V1'
];

// ==========================================
// DB INITIALIZATION (Dinamica)
// ==========================================
function initDB(db) {
    console.log("[DB Init] Initializing tables and triggers...");

    for (const [tableName, config] of Object.entries(SYNC_CONFIG)) {
        const columnsInfo = db.pragma(`table_info(${tableName})`);
        const colNames = columnsInfo.map(c => c.name);

        // 1. Add Technical Columns
        if (!colNames.includes('pb_id')) db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_id TEXT;`);
        if (!colNames.includes('pb_updated_at')) db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_updated_at TEXT;`);
        if (!colNames.includes('pb_is_dirty')) {
            db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_is_dirty INTEGER DEFAULT 0;`);
            db.exec(`UPDATE ${tableName} SET pb_is_dirty = 1;`);
        }
        if (!colNames.includes('pb_is_deleted')) db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_is_deleted INTEGER DEFAULT 0;`);

        // 2. Deterministic IDs (per record esistenti < 100 o tabelle config)
        const prefix = tableName.substring(0, 5).toLowerCase();
        db.prepare(`
            UPDATE ${tableName} 
            SET pb_id = '${prefix}' || printf('%07d', ${config.pk}), pb_is_dirty = 1
            WHERE (pb_id IS NULL OR pb_id = '') AND ${config.pk} < 1000
        `).run();

        // 3. Smart Triggers
        const whenClause = config.fields.map(f => `NEW.${f} IS NOT OLD.${f}`).join(' OR ');

        db.exec(`
            CREATE TRIGGER IF NOT EXISTS TRG_${tableName}_INSERT AFTER INSERT ON ${tableName}
            FOR EACH ROW WHEN NEW.pb_is_dirty IS NOT 2
            BEGIN
                UPDATE ${tableName} SET pb_is_dirty = 1, pb_updated_at = STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'NOW')
                WHERE ${config.pk} = NEW.${config.pk};
            END;
        `);

        db.exec(`
            CREATE TRIGGER IF NOT EXISTS TRG_${tableName}_UPDATE AFTER UPDATE ON ${tableName}
            FOR EACH ROW WHEN ((${whenClause}) AND NEW.pb_is_dirty IS NOT 2)
            BEGIN
                UPDATE ${tableName} SET pb_is_dirty = 1, pb_updated_at = STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'NOW')
                WHERE ${config.pk} = NEW.${config.pk};
            END;
        `);
    }
}

// ==========================================
// CORE SYNC LOGIC (Generica)
// ==========================================
async function syncPush(db, pb, tableName) {
    const config = SYNC_CONFIG[tableName];
    const records = db.prepare(`SELECT * FROM ${tableName} WHERE pb_is_dirty = 1`).all();
    if (records.length === 0) return;

    console.log(`[Push] ${tableName}: Syncing ${records.length} changes...`);
    for (const record of records) {
        // Pulizia dati per PocketBase (evita -1 su campi numerici se necessario)
        const payload = { ...record };
        delete payload.pb_is_dirty; // Non serve al cloud

        try {
            let remote;
            try {
                remote = await pb.collection(tableName).getOne(record.pb_id);
                await pb.collection(tableName).update(record.pb_id, payload);
            } catch {
                await pb.collection(tableName).create({ id: record.pb_id, ...payload });
            }
            db.prepare(`UPDATE ${tableName} SET pb_is_dirty = 0 WHERE ${config.pk} = ?`).run(record[config.pk]);
        } catch (e) {
            console.error(`  Error pushing ${tableName} ID ${record[config.pk]}:`, e.message);
        }
    }
}

async function syncPull(db, pb, tableName) {
    const config = SYNC_CONFIG[tableName];
    const lastSync = db.prepare(`SELECT MAX(pb_updated_at) as ts FROM ${tableName}`).get().ts || '1970-01-01';

    try {
        const remoteRecords = await pb.collection(tableName).getFullList({
            filter: `updated > "${lastSync.replace('Z', '').replace('T', ' ')}"`
        });

        if (remoteRecords.length === 0) return;
        console.log(`[Pull] ${tableName}: Downloading ${remoteRecords.length} records...`);

        const updateStmt = db.prepare(`
            UPDATE ${tableName} SET ${config.fields.map(f => `${f} = ?`).join(', ')}, 
            pb_updated_at = ?, pb_is_dirty = 2 WHERE pb_id = ?
        `);

        for (const rmt of remoteRecords) {
            const local = db.prepare(`SELECT ${config.pk} FROM ${tableName} WHERE pb_id = ?`).get(rmt.id);
            if (local) {
                const values = config.fields.map(f => rmt[f]);
                updateStmt.run(...values, rmt.updated, rmt.id);
            } else {
                // Semplificato: Inserimento nuovi record (logica simile a sync.js originale)
                // ... logic insert ...
            }
        }
        db.prepare(`UPDATE ${tableName} SET pb_is_dirty = 0 WHERE pb_is_dirty = 2`).run();
    } catch (e) {
        console.error(`  Error pulling ${tableName}:`, e.message);
    }
}

// ==========================================
// MAIN EXECUTION
// ==========================================
async function main() {
    const db = new Database(DB_PATH);
    const pb = new PocketBase(PB_URL);

    try {
        await pb.admins.authWithPassword(PB_USER, PB_PASS);
        initDB(db);

        for (const table of SYNC_ORDER) {
            await syncPush(db, pb, table);
            await syncPull(db, pb, table);
        }
        console.log("\n✅ Global Sync Completed.");
    } catch (err) {
        console.error("Critical Sync Error:", err);
    } finally {
        db.close();
    }
}

main();