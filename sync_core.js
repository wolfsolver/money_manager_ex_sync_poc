const Database = require('better-sqlite3');
const PocketBase = require('pocketbase/cjs');

// ==========================================
// CONFIGURATION & MAPPING
// ==========================================
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.split('=');
    const cleanKey = key.replace('--', '');
    acc[cleanKey] = value !== undefined ? value : true; // Gestisce flag senza valore come --init
    return acc;
}, {});

// Lista dei parametri e comandi validi
const VALID_ARGS = ['db', 'url', 'user', 'pass', 'init', 'push', 'pull', 'clearServer', 'help', 'forcepush'];
// 1. Controllo parametri sconosciuti
const unknownArgs = Object.keys(args).filter(key => !VALID_ARGS.includes(key));
if (unknownArgs.length > 0) {
    console.error(`❌ Error: Unknown parameter(s): ${unknownArgs.join(', ')}`);
    console.log("Use --help to see the list of available commands.");
    process.exit(1);
}

// ==========================================
// ARGUMENTS HELP
// ==========================================
if (args.help) {
    console.log(`
MMEX to PocketBase Sync Tool (POC)
Usage: node sync_core.js [options]

Options:
  --db=<path>       Path to the local SQLite database (default: ./sample_db.mmb)
  --url=<url>       PocketBase server URL (default: http://127.0.0.1:8090)
  --user=<email>    PocketBase admin email
  --pass=<password> PocketBase admin password

Commands (can be combined):
  --init            Initialize technical columns and triggers in local DB
  --push            Push local changes (dirty records) to PocketBase
  --pull            Pull remote changes from PocketBase to local DB
  --clearServer     Delete all records from PocketBase collections (respecting SYNC_ORDER)
  --help            Show this help message
  --forcepush       Push all records from local DB to PocketBase (not only dirty records)
                    Include --push

Notes:
  - If no command (--init, --push, --pull) is provided, the script runs all three by default.
  - The --clearServer command is executed before any other sync operation.
    `);
    process.exit(0);
}

const RUN_FORCEPUSH = args.forcepush === true;
const RUN_CLEAR = args.clearServer === true;
let RUN_INIT = args.init === true;
let RUN_PUSH = args.push === true || RUN_FORCEPUSH;
let RUN_PULL = args.pull === true;
if (!RUN_INIT && !RUN_PUSH && !RUN_PULL && !RUN_CLEAR) { // no param.. all true
    RUN_INIT = true;
    RUN_PUSH = true;
    RUN_PULL = true;
}

const PB_USER = args.user || process.env.PB_USER || 'admin@mmex.it';
const PB_PASS = args.pass || process.env.PB_PASS || 'password123';
const PB_URL = args.url || process.env.PB_URL || 'http://127.0.0.1:8090';
const DB_PATH = args.db || process.env.DB_PATH || null;

// Definizione delle tabelle da sincronizzare e dei campi da monitorare per il trigger
const SYNC_CONFIG = {
    'INFOTABLE_V1': { pk: 'INFOID', fields: ['INFONAME', 'INFOVALUE'] },
    'CATEGORY_V1': { pk: 'CATEGID', fields: ['CATEGNAME', 'ACTIVE', 'PARENTID'] },
    'PAYEE_V1': { pk: 'PAYEEID', fields: ['PAYEENAME', 'ACTIVE', 'CATEGID'] },
    'ACCOUNTLIST_V1': { pk: 'ACCOUNTID', fields: ['ACCOUNTNAME', 'ACCOUNTTYPE', 'STATUS', 'FAVORITEACCT', 'INITIALDATE', 'INITIALBAL', 'CURRENCYID'] },
    'CHECKINGACCOUNT_V1': { pk: 'TRANSID', fields: ['ACCOUNTID', 'TOACCOUNTID', 'PAYEEID', 'TRANSCODE', 'TRANSAMOUNT', 'STATUS', 'CATEGID', 'TRANSDATE', 'NOTES'] },
    'BILLSDEPOSITS_V1': { pk: 'BDID', fields: ['ACCOUNTID', 'PAYEEID', 'TRANSCODE', 'TRANSAMOUNT', 'CATEGID', 'NEXTOCCURRENCEDATE'] },
    //    'BUDGETSPLITTRANSACTIONS_V1': { pk: 'SPLITTRANSID', fields: ['TRANSID', 'CATEGID', 'SPLITTRANSAMOUNT'] }
};

// Ordine di sincronizzazione per rispettare le Foreign Keys
const SYNC_ORDER = [
    'INFOTABLE_V1',
    'CATEGORY_V1',
    'PAYEE_V1',
    'ACCOUNTLIST_V1',
    'CHECKINGACCOUNT_V1',
    'BILLSDEPOSITS_V1',
    //    'BUDGETSPLITTRANSACTIONS_V1'
];

// TODO: Change name from check_userVersion to isValidUserVersion
async function check_userVersion(db, pb) {
    // befor start we need to check if pragmaUserVersion is greather or equal to the remote database version.
    // remote Pragma is inside collection "dbInfo" record "PRAGMA_USER_VERSION_MIN"
    // if not, we cannot sync the local db must be updated before syncing remote db.
    const pragmaUserVersion = db.pragma(`user_version`)[0].user_version;
    //console.log("Pragma user version: ", pragmaUserVersion);

    const remotePragmaUserVersion = await pb.collection("dbInfo").getFirstListItem('KEY="PRAGMA_USER_VERSION_MIN"');
    //console.log("Remote Pragma user version: ", remotePragmaUserVersion.VALUE);
    if (pragmaUserVersion < remotePragmaUserVersion.VALUE) {
        console.log(`[Sync] Pragma user version ${pragmaUserVersion} is smaller than remote database version ${remotePragmaUserVersion.VALUE}. Updating local database to match remote database...`);
        return false;
    }
    console.log(`[Sync] Pragma user version ${pragmaUserVersion} is compatible with remote database version ${remotePragmaUserVersion.VALUE}. Syncing local to remote database...`);
    return true;

}

// ==========================================
// CLEAR REMOTE SERVER (Cleanup)
// ==========================================
async function clearRemoteServer(pb) {
    console.log("[Clear] Starting remote server cleanup...");

    // Invertiamo l'ordine per rispettare i vincoli di integrità referenziale
    const reverseOrder = [...SYNC_ORDER].reverse();

    for (const tableName of reverseOrder) {
        try {
            const records = await pb.collection(tableName).getFullList({ fields: 'id' });
            if (records.length === 0) continue;

            console.log(`[Clear] Removing ${records.length} records from ${tableName}...`);
            for (const record of records) {
                await pb.collection(tableName).delete(record.id);
            }
        } catch (e) {
            console.error(`  Error clearing table ${tableName}:`, e.message);
        }
    }
    console.log("✅ Remote server cleared.");
}

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
        if (!colNames.includes('pb_is_dirty')) db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_is_dirty INTEGER DEFAULT 0;`);
        if (!colNames.includes('pb_is_deleted')) db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_is_deleted INTEGER DEFAULT 0;`);

        // 2. Deterministic IDs (per record esistenti < 100 o tabelle config)
        // id need to be 15 char. use: systemconstxxxx
        //                             123456789012345
        const prefix = 'systemconst';
        db.prepare(`
            UPDATE ${tableName} 
            SET pb_id = '${prefix}' || printf('%04d', ${config.pk}), pb_is_dirty = 1
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
    const records = RUN_FORCEPUSH ?
        db.prepare(`SELECT * FROM ${tableName}`).all() :
        db.prepare(`SELECT * FROM ${tableName} WHERE pb_is_dirty = 1 OR pb_id = '' OR pb_id IS NULL`).all();
    if (records.length === 0) return;

    console.log(`[Push] ${tableName}: Syncing ${records.length} changes...`);
    for (const record of records) {
        // Pulizia dati per PocketBase (evita -1 su campi numerici se necessario)
        const payload = { ...record };
        delete payload.pb_is_dirty; // Non serve al cloud
        payload.id = payload.pb_id; delete payload.pb_id;
        payload.updated_at = payload.pb_updated_at; delete payload.pb_updated_at;
        payload.is_deleted = payload.pb_is_deleted; delete payload.pb_is_deleted;

        Object.keys(payload).forEach(key => {
            if (payload[key] == null) {
                delete payload[key];
            }
        });
        //        console.log("Payload: ", payload);

        let remoteRecord;
        try {
            let remote;
            try {
                remote = await pb.collection(tableName).getOne(record.pb_id);
                remoteRecord = await pb.collection(tableName).update(record.pb_id, payload);
            } catch {
                remoteRecord = await pb.collection(tableName).create({ id: record.pb_id, ...payload });
            }
            db.prepare(`UPDATE ${tableName} SET pb_is_dirty = 0, pb_id = ? WHERE ${config.pk} = ?`).run(remoteRecord.id, record[config.pk]);
        } catch (e) {
            console.error(`  Error pushing ${tableName} ID ${record[config.pk]}:`, e.message);
        }
    }
}

async function syncPull(db, pb, tableName) {

    const config = SYNC_CONFIG[tableName];
    //const lastSync = db.prepare(`SELECT MAX(pb_updated_at) as ts FROM ${tableName}`).get().ts || '1970-01-01';
    const lastSync = '1970-01-01T00:00:00.000Z';

    let last_rmt = null;

    try {
        const remoteRecords = await pb.collection(tableName).getFullList({
            //            filter: `updated > "${lastSync.replace('Z', '').replace('T', ' ')}"`
        });

        if (remoteRecords.length === 0) return;
        console.log(`[Pull] ${tableName}: Downloading ${remoteRecords.length} records...`);

        for (const rmt of remoteRecords) {
            last_rmt = rmt;
            const local = db.prepare(`SELECT ${config.pk} FROM ${tableName} WHERE pb_id = ?`).get(rmt.id);
            //console.log("record", rmt.id, "is present? [", local, "]:", `SELECT ${config.pk} FROM ${tableName} WHERE pb_id = "${rmt.id}"`);
            if (local) {
                // use universal id from pb to updatel
                const updateStmt = db.prepare(`
                    UPDATE ${tableName} SET ${config.fields.map(f => `${f} = ?`).join(', ')}, 
                    pb_updated_at = ?, pb_is_dirty = 2 WHERE pb_id = ?
                `);
                const values = config.fields.map(f => rmt[f]);
                updateStmt.run(...values, rmt.updated, rmt.id);
            } else {
                // New ID remotely -> insert locally
                //                const local = db.prepare(`SELECT ${config.pk} FROM ${tableName} WHERE ${config.pk} = ?`).get(rmt[config.pk]);

                // Costruiamo dinamicamente i nomi delle colonne e i segnaposti (?)
                const columns = [...config.fields, 'pb_id', 'pb_updated_at', 'pb_is_dirty'];
                const placeholders = columns.map(() => '?').join(', ');

                // Prepariamo i valori (mettiamo pb_is_dirty = 2)
                const values = [...config.fields.map(f => rmt[f]), rmt.id, rmt.updated, 2];

                const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
                db.prepare(insertSql).run(...values);

            }
        }
        db.prepare(`UPDATE ${tableName} SET pb_is_dirty = 0 WHERE pb_is_dirty = 2`).run();
    } catch (e) {
        console.error(`  Error pulling ${tableName}:\n${JSON.stringify(last_rmt, null, 2)}\n `, e.message);
    }
}

// ==========================================
// MAIN EXECUTION
// ==========================================
async function main() {
    const pb = new PocketBase(PB_URL);
    const db = DB_PATH == null ? null : new Database(DB_PATH);

    if (db == null) {
        // olny perform RUN_CLEAR is set
        RUN_INIT = false;
        RUN_PULL = false;
        RUN_PUSH = false;
    }

    try {
        await pb.admins.authWithPassword(PB_USER, PB_PASS);
        if (db != null && (!await check_userVersion(db, pb))) return;

        if (RUN_CLEAR) await clearRemoteServer(pb);
        if (RUN_INIT) initDB(db);

        for (const table of SYNC_ORDER) {
            if (RUN_PUSH) await syncPush(db, pb, table);
            if (RUN_PULL) await syncPull(db, pb, table);
        }
        console.log("\n✅ Global Sync Completed.");
    } catch (err) {
        console.error("Critical Sync Error:", err);
    } finally {
        if (db != null) db.close();
    }
}

main();