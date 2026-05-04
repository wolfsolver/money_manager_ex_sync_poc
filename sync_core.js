import Database from 'better-sqlite3';
import PocketBase from 'pocketbase';
import fs from 'fs';
import chokidar from 'chokidar';
import { EventSource } from 'eventsource';
global.EventSource = EventSource;
import { SYNC_CONFIG, SYNC_ORDER } from './config/table_config.js';

// ==========================================
// CONFIGURATION & MAPPING
// ==========================================
let args = {};
if (typeof process !== 'undefined' && process.argv) {
    args = process.argv.slice(2).reduce((acc, arg) => {
        const [key, value] = arg.split('=');
        const cleanKey = key.replace('--', '');
        acc[cleanKey] = value !== undefined ? value : true; // Gestisce flag senza valore come --init
        return acc;
    }, {});
}

// Lista dei parametri e comandi validi
const VALID_ARGS = ['db', 'url', 'user', 'pass', 'init', 'push', 'pull', 'clearServer', 'help', 'forcepush', 'forcepull', 'create', 'config_file', 'watch', 'verbose'];

// 1. Controllo parametri sconosciuti
const unknownArgs = Object.keys(args).filter(key => !VALID_ARGS.includes(key));
if (unknownArgs.length > 0) {
    console.error(`❌ Error: Unknown parameter(s): ${unknownArgs.join(', ')}`);
    console.log("Use --help to see the list of available commands.");
    if (process.argv && process.argv.length > 2 && process.argv[1].includes('sync_core.js')) process.exit(1);
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
  --user=<email>    PocketBase email
  --pass=<password> PocketBase password
  --config_file=<nome_file>  Name of the config file to store last sync timestamp (default: .lastsync)

Commands (can be combined):
  --init            Initialize technical columns and triggers in local DB
  --push            Push local changes (dirty records) to PocketBase
  --pull            Pull remote changes from PocketBase to local DB
  --clearServer     Delete all records from PocketBase collections (respecting SYNC_ORDER)
  --help            Show this help message
  --forcepush       Push all records from local DB to PocketBase (not only dirty records)
                    Include --push
  --forcepull       Pull all record from Pocketbase to local db (not only newer records)
                    Include --pull
  --create          Create empty databse and all tables
                    Include --init
  --watch           Run the script in watch mode, monitoring the database file for changes
                    Include --push and --pull
  --verbose         Enable verbose logging

Notes:
  - If no command (--init, --push, --pull) is provided, the script runs all three by default.
  - The --clearServer command is executed before any other sync operation.
    `);
    if (process.argv && process.argv.length > 2 && process.argv[1].includes('sync_core.js')) process.exit(0);
}

export let RUN_FORCEPUSH = args.forcepush === true;
export let RUN_FORCEPULL = args.forcepull === true;
export let RUN_CLEAR = args.clearServer === true;
export let RUN_CREATE = args.create === true;
export let RUN_WATCH = args.watch === true;
export let RUN_VERBOSE = args.verbose === true;
export let RUN_INIT = args.init === true || args.create === true;
export let RUN_PUSH = args.push === true || RUN_FORCEPUSH;
export let RUN_PULL = args.pull === true || RUN_FORCEPULL;

// se eseguito da riga di comando e non ci sono parametri di comando, esegue tutto
if (!RUN_INIT && !RUN_PUSH && !RUN_PULL && !RUN_CLEAR && Object.keys(args).length > 0) {
    RUN_INIT = true;
    RUN_PUSH = true;
    RUN_PULL = true;
}

export let PB_USER = args.user || process.env.PB_USER || '';
export let PB_PASS = args.pass || process.env.PB_PASS || '';
export let PB_URL = args.url || process.env.PB_URL || '';
export let DB_PATH = args.db || process.env.DB_PATH || '';
export let PB_TOKEN = '';
export let CONFIG_FILE = args.config_file || '.lastsync';

export function setSyncConfig(config) {
    if (config.forcepush !== undefined) RUN_FORCEPUSH = config.forcepush;
    if (config.forcepull !== undefined) RUN_FORCEPULL = config.forcepull;
    if (config.clearServer !== undefined) RUN_CLEAR = config.clearServer;
    if (config.create !== undefined) RUN_CREATE = config.create;
    if (config.watch !== undefined) RUN_WATCH = config.watch;
    if (config.verbose !== undefined) RUN_VERBOSE = config.verbose;
    if (config.init !== undefined) RUN_INIT = config.init;
    if (config.push !== undefined) RUN_PUSH = config.push;
    if (config.pull !== undefined) RUN_PULL = config.pull;
    if (config.user !== undefined) PB_USER = config.user;
    if (config.pass !== undefined) PB_PASS = config.pass;
    if (config.token !== undefined) PB_TOKEN = config.token;
    if (config.url !== undefined) PB_URL = config.url;
    if (config.db !== undefined) DB_PATH = config.db;
    if (config.config_file !== undefined) CONFIG_FILE = config.config_file;
}

// TODO: Change name from check_userVersion to isValidUserVersion
async function check_userVersion(db, pb) {
    // befor start we need to check if pragmaUserVersion is greather or equal to the remote database version.
    // remote Pragma is inside collection "dbInfo" record "PRAGMA_USER_VERSION_MIN"
    // if not, we cannot sync the local db must be updated before syncing remote db.
    const pragmaUserVersion = db.pragma(`user_version`)[0].user_version;
    if (RUN_VERBOSE) console.log("Pragma user version: ", pragmaUserVersion);

    const remotePragmaUserVersion = await pb.collection("dbInfo").getFirstListItem('KEY="PRAGMA_USER_VERSION_MIN"');
    if (RUN_VERBOSE) console.log("Remote Pragma user version: ", remotePragmaUserVersion.VALUE);
    if (pragmaUserVersion < remotePragmaUserVersion.VALUE) {
        console.log(`[Sync] ERROR: Pragma user version ${pragmaUserVersion} is smaller than remote database version ${remotePragmaUserVersion.VALUE}. Updating local database to match remote database...`);
        return false;
    }
    if (RUN_VERBOSE) console.log(`[Sync] Pragma user version ${pragmaUserVersion} is compatible with remote database version ${remotePragmaUserVersion.VALUE}. Syncing local to remote database...`);
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
                if (RUN_VERBOSE) console.log(`[Clear] Removed record ${record.id} from ${tableName}...`);
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

    db.exec(`
        CREATE TABLE IF NOT EXISTS pb_DELETED_RECORDS_LOG (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            pb_id TEXT NOT NULL,
            deleted_at TEXT DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'NOW'))
        );
    `);

    for (const [tableName, config] of Object.entries(SYNC_CONFIG)) {
        const columnsInfo = db.pragma(`table_info(${tableName})`);
        const colNames = columnsInfo.map(c => c.name);

        // 1. Add Technical Columns
        if (!colNames.includes('pb_id')) db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_id TEXT;`);
        if (!colNames.includes('pb_updated_at')) db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_updated_at TEXT;`);
        if (!colNames.includes('pb_is_dirty')) db.exec(`ALTER TABLE ${tableName} ADD COLUMN pb_is_dirty INTEGER DEFAULT 0;`);

        /*
        // not used: we mcannot "merge" two local db. 
        // 2. Deterministic IDs (per record esistenti < 100 o tabelle config)
        // id need to be 15 char. use: systemconstxxxx
        //                             123456789012345
        const prefix = 'systemconst';
        db.prepare(`
            UPDATE ${tableName} 
            SET pb_id = '${prefix}' || printf('%04d', ${config.pk}), pb_is_dirty = 1
            WHERE (pb_id IS NULL OR pb_id = '') AND ${config.pk} < 1000
        `).run();
        */

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

        db.exec(`
            CREATE TRIGGER IF NOT EXISTS TRG_${tableName}_DELETE AFTER DELETE ON ${tableName}
            FOR EACH ROW WHEN OLD.pb_id IS NOT NULL AND OLD.pb_id != ''
            BEGIN
                INSERT INTO pb_DELETED_RECORDS_LOG (table_name, pb_id) VALUES ('${tableName}', OLD.pb_id);
            END;
        `);
    }
}

// ==========================================
// CORE SYNC LOGIC (Generica)
// ==========================================
async function syncPush(db, pb, tableName) {
    const config = SYNC_CONFIG[tableName];

    // Process Deletions First
    const deletedRecords = db.prepare(`SELECT * FROM pb_DELETED_RECORDS_LOG WHERE table_name = ?`).all(tableName);
    if (deletedRecords.length > 0) {
        console.log(`[Push] ${tableName}: Syncing ${deletedRecords.length} deletions...`);
        for (const delRecord of deletedRecords) {
            try {
                // we dont delete from pb directly. We use soft delete on pb
                const payload = { _is_deleted: 1 };
                const remoteRecord = await pb.collection(tableName).update(delRecord.pb_id, payload);
                if (remoteRecord._is_deleted === 1) {
                    db.prepare(`DELETE FROM pb_DELETED_RECORDS_LOG WHERE id = ?`).run(delRecord.id);
                    if (RUN_VERBOSE) console.log(`[Push] Deleted record ${delRecord.pb_id} from ${tableName}...`);
                }
            } catch (e) {
                console.error(`  Error pushing deletion for ${tableName} ID ${delRecord.pb_id}:`, e.message);
            }
        }
    }

    const records = RUN_FORCEPUSH ?
        db.prepare(`SELECT * FROM ${tableName}`).all() :
        db.prepare(`SELECT * FROM ${tableName} WHERE pb_is_dirty = 1 OR pb_id = '' OR pb_id IS NULL`).all();
    if (records.length === 0) return;

    console.log(`[Push] ${tableName}: Syncing ${records.length} changes...`);
    for (const record of records) {
        if (RUN_VERBOSE) console.log(`[Push] ${tableName}: Syncing record ${record[config.pk]}...`);
        // Pulizia dati per PocketBase (evita -1 su campi numerici se necessario)
        const payload = { ...record };
        delete payload.pb_is_dirty; // Non serve al cloud
        payload.id = payload.pb_id; delete payload.pb_id;
        payload._updated_at = payload.pb_updated_at; delete payload.pb_updated_at;

        Object.keys(payload).forEach(key => {
            if (payload[key] == null) {
                delete payload[key];
            }
        });
        //        console.log("Payload: ", payload);

        let remoteRecord;
        const pb_id = record.pb_id;

        try {
            // Gestione logica: se ho un ID provo l'UPDATE, altrimenti vado diretto in CREATE
            if (pb_id && pb_id.trim() !== "") {
                try {
                    remoteRecord = await pb.collection(tableName).update(pb_id, payload);
                } catch (err) {
                    if (err.status === 404) {
                        // Il record aveva un ID ma non esiste sul server -> Lo creo con quell'ID
                        if (RUN_VERBOSE) console.log(`[Push] ${tableName}: existing ID but not found on server. Now creating record ${record[config.pk]}...`);
                        remoteRecord = await pb.collection(tableName).create({ id: pb_id, ...payload });
                    } else {
                        throw err; // Errore di validazione o permessi
                    }
                }
            } else {
                // CASO 1: ID Blank -> Creazione pura (PocketBase genererà l'ID)
                remoteRecord = await pb.collection(tableName).create(payload);
            }

            // A questo punto remoteRecord contiene sicuramente l'ID finale (nuovo o esistente)
            const updateSql = `UPDATE ${tableName} SET pb_is_dirty = 0, pb_id = ? WHERE ${config.pk} = ?`;
            db.prepare(updateSql).run(remoteRecord.id, record[config.pk]);

            if (RUN_VERBOSE) console.log(`[Push] ${tableName}: Synced record ${record[config.pk]}...`);

        } catch (e) {
            // Questo catch cattura errori di rete, permessi o fallimenti del DB locale
            console.error(`  Error pushing ${tableName} ID ${record[config.pk]}:`, e.message);
        }

    }
}

async function syncPull(db, pb, tableName, lastSync) {

    const config = SYNC_CONFIG[tableName];

    let last_rmt = null;

    try {
        let remoteRecords;
        if (RUN_FORCEPULL || lastSync == null) {
            remoteRecords = await pb.collection(tableName).getFullList({
                sort: '_updated_at' // Opzionale: utile per mantenere l'ordine cronologico
            });
        } else {
            remoteRecords = await pb.collection(tableName).getFullList({
                filter: `updated > "${lastSync}"`,
                sort: '_updated_at' // Opzionale: utile per mantenere l'ordine cronologico
            });
        }

        if (remoteRecords.length === 0) return;
        console.log(`[Pull] ${tableName}: Downloading ${remoteRecords.length} records...`);

        for (const rmt of remoteRecords) {
            last_rmt = rmt;

            // we need to check if remote record is deleted on server
            if (rmt._is_deleted === 1) {
                // ToDo: need to be checked if delete cause a loop . this statemetn will probbiliy trigger the update trigger
                db.prepare(`DELETE FROM ${tableName} WHERE pb_id = ?`).run(rmt.id);
                continue;
            }

            const local = db.prepare(`SELECT ${config.pk} FROM ${tableName} WHERE pb_id = ?`).get(rmt.id);
            //console.log("record", rmt.id, "is present? [", local, "]:", `SELECT ${config.pk} FROM ${tableName} WHERE pb_id = "${rmt.id}"`);
            if (local) {
                // use universal id from pb to updatel
                const updateStmt = db.prepare(`
                    UPDATE ${tableName} SET ${config.pk} = ?, ${config.fields.map(f => `${f} = ?`).join(', ')}, 
                    pb_updated_at = ?, pb_is_dirty = 2 WHERE pb_id = ?
                `);
                const values = [rmt[config.pk], ...config.fields.map(f => rmt[f]), rmt._updated_at, rmt.id];
                updateStmt.run(...values);
            } else {
                // New ID remotely -> insert locally
                //                const local = db.prepare(`SELECT ${config.pk} FROM ${tableName} WHERE ${config.pk} = ?`).get(rmt[config.pk]);

                // Costruiamo dinamicamente i nomi delle colonne e i segnaposti (?)
                const columns = [config.pk, ...config.fields, 'pb_id', 'pb_updated_at', 'pb_is_dirty'];
                const placeholders = columns.map(() => '?').join(', ');

                // Prepariamo i valori (mettiamo pb_is_dirty = 2)
                const values = [rmt[config.pk], ...config.fields.map(f => rmt[f]), rmt.id, rmt._updated_at, 2];

                const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
                db.prepare(insertSql).run(...values);

            }
        }
        db.prepare(`UPDATE ${tableName} SET pb_is_dirty = 0 WHERE pb_is_dirty = 2`).run();
    } catch (e) {
        console.error(`  Error pulling ${tableName}:\n${JSON.stringify(last_rmt, null, 2)}\n `, e.message);
    }
}


/**
 * Crea un nuovo database da zero usando lo schema MMEX originale
 */
function createEmptyDatabase(dbPath) {
    console.log(`[Create] Creating new database at ${dbPath}...`);

    // Rimuove il file se esiste già per una creazione pulita
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
    }

    const db = new Database(dbPath);

    try {
        // 1. Legge ed esegue il file table_v1.sql
        const sqlSchema = fs.readFileSync('tables_v1_for_sync.sql', 'utf8');
        db.exec(sqlSchema);
        if (RUN_VERBOSE) console.log("[Create] SQL Schema applied successfully.");

        // 2. Imposta il PRAGMA user_version a 21
        db.pragma('user_version = 21');
        if (RUN_VERBOSE) console.log("[Create] PRAGMA user_version set to 21.");

        return db;
    } catch (err) {
        console.error("❌ [Create] Error creating database:", err.message);
        db.close();
        process.exit(1);
    }
}

// ==========================================
// MAIN EXECUTION
// ==========================================
export async function runSyncCycle() {
    const pb = new PocketBase(PB_URL);
    let db = null;
    if (DB_PATH == null) {
        // olny perform RUN_CLEAR is set
        RUN_INIT = false;
        RUN_PULL = false;
        RUN_PUSH = false;
    }

    try {
        if (PB_TOKEN) {
            pb.authStore.save(PB_TOKEN, null);
        } else if (PB_PASS) {
            await pb.collection('users').authWithPassword(PB_USER, PB_PASS);
        }

        if (RUN_CLEAR) await clearRemoteServer(pb);

        // Se RUN_CREATE è attivo, inizializza il DB prima di ogni altra operazione
        if (RUN_CREATE) {
            if (!DB_PATH) {
                console.error("❌ Error: --db=<path> is required when using --create");
                process.exit(1);
            }
            db = createEmptyDatabase(DB_PATH);
        } else if (DB_PATH != null) {
            db = new Database(DB_PATH, { timeout: 5000 });
        }

        if (db) {
            db.prepare('BEGIN IMMEDIATE').run();
            console.log("[Lock] Local database locked for sync.");
        }


        if (db != null && (!await check_userVersion(db, pb))) return;
        if (RUN_INIT) initDB(db);

        let globalLastSync = '1970-01-01 00:00:00.000Z';
        const lastSyncFile = CONFIG_FILE;
        let pullStartTime = null;

        if (RUN_PULL) {
            if (fs.existsSync(lastSyncFile)) {
                let fileContent = fs.readFileSync(lastSyncFile, 'utf8').trim();
                if (fileContent) globalLastSync = fileContent;
            }
            pullStartTime = new Date().toISOString().replace('T', ' ');
            console.log(`[Pull] Using last sync time: ${globalLastSync}`);
        }

        // TODO remote lock, remote table sync_lock need to be created...
        // const lock = await pb.collection('sync_locks').create({ device: DB_PATH, expires: new Date(Date.now() + 60000) });
        for (const table of SYNC_ORDER) {
            if (RUN_PUSH) await syncPush(db, pb, table);
            if (RUN_PULL) await syncPull(db, pb, table, globalLastSync);
        }
        // await pb.collection('sync_locks').delete(lock.id);

        if (RUN_PULL) {
            fs.writeFileSync(lastSyncFile, pullStartTime, 'utf8');
            console.log(`[Pull] Saved new last sync time: ${pullStartTime}`);
        }

        // release lock
        if (db) {
            db.prepare('COMMIT').run();
            console.log("[Lock] Local database unlocked (Changes committed).");
        }


        console.log("\n✅ Global Sync Completed.");
    } catch (err) {
        console.error("Critical Sync Error:", err);
        if (db && db.inTransaction) {
            db.prepare('ROLLBACK').run();
            console.log("[Lock] Local database unlocked (Rollback due to error).");
        }
    } finally {
        if (db != null) db.close();
    }
}

async function startWatcher() {
    console.log(`[Watcher] Monitoring for changes in: ${DB_PATH}`);

    const watcher = chokidar.watch(DB_PATH, {
        persistent: true,
        usePolling: true, // Necessario per file SQLite spesso bloccati
        interval: 1000
    });

    const triggerSync = async (source) => {
        console.log(`\n[Watcher] ${source === 'local' ? 'File' : 'Remote'} change detected. Starting sync...`);

        try {
            // Eseguiamo una sessione completa di Push/Pull
            await runSyncCycle();
        } catch (err) {
            console.error("[Watcher] Sync failed:", err.message);
        }

        console.log("[Watcher] Sync cycle finished. Waiting for next change...");
    };

    watcher.on('change', async () => {
        console.log("[Watcher] File change detected");
        await triggerSync('local');
    });

    try {
        const pb = new PocketBase(PB_URL);
        if (PB_TOKEN) {
            pb.authStore.save(PB_TOKEN, null);
        } else if (PB_PASS) {
            await pb.collection('users').authWithPassword(PB_USER, PB_PASS);
        }
        console.log("[Watcher] Connected to PocketBase for realtime updates.");

        for (const table of SYNC_ORDER) {
            pb.collection(table).subscribe('*', async (e) => {
                console.log(`[Watcher] Remote change on ${table} (${e.action}).`);
                await triggerSync('remote');
            });
            console.log(`[Watcher] Subscribed on table: ${table}`);
        }
    } catch (err) {
        console.error("[Watcher] Failed to setup remote watcher:", err.message);
    }
}

export async function main() {
    const pb = new PocketBase(PB_URL);
    let db = null;
    if (DB_PATH == null) {
        // olny perform RUN_CLEAR is set
        RUN_INIT = false;
        RUN_PULL = false;
        RUN_PUSH = false;
    }

    console.log(`[Sync] Starting sync for user ${PB_USER}`);
    console.log(`[Sync]               using PB URL: ${PB_URL}`);
    console.log(`[Sync]               using DB_PATH ${DB_PATH}`);
    if (RUN_CREATE) {
        if (!DB_PATH) {
            console.error("❌ Error: --db=<path> is required when using --create");
            process.exit(1);
        }
        db = createEmptyDatabase(DB_PATH);
        db.close();
        process.exit(0);
    }

    await runSyncCycle();
    if (RUN_WATCH) {
        startWatcher();
    }

}

// Execute main only if the file is called directly
if (typeof process !== 'undefined' && process.argv && process.argv.length > 1 && process.argv[1].includes('sync_core.js')) {
    main();
}