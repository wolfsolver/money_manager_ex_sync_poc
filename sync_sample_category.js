const Database = require('better-sqlite3');
const PocketBase = require('pocketbase/cjs');


// Funzione per estrarre i parametri tipo --chiave=valore
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.split('=');
    if (key.startsWith('--')) {
        acc[key.replace('--', '')] = value;
    }
    return acc;
}, {});

// ==========================================
// CONFIGURATION
// ==========================================
// Configure the database path and PocketBase credentials here.
// You can override these using environment variables if desired.
const PB_USER = args.user || process.env.PB_USER || 'your@email.com';
const PB_PASS = args.pass || process.env.PB_PASS || 'password';
const DB_PATH = args.db || process.env.DB_PATH || './sample_db.mmb';
const PB_URL = args.url || process.env.PB_URL || 'http://127.0.0.1:8090'; // PocketBase instance URL

const PB_COLLECTION = 'category_v1';             // Name of the PocketBase collection
console.log("Argomenti ricevuti:", process.argv);
console.log("Argomenti ricevuti: USER", PB_USER);
console.log("Argomenti ricevuti: DB", DB_PATH);


/**
 * Initializes the database schema, installs columns, sets deterministic IDs, and creates triggers.
 */
function initDB(db) {
    console.log("[DB Init] Checking Database schema...");

    const columnsInfo = db.pragma('table_info(CATEGORY_V1)');
    const colNames = columnsInfo.map(c => c.name);

    // 1. Add Technical Columns dynamically if they don't exist
    if (!colNames.includes('pb_id')) {
        db.exec(`ALTER TABLE CATEGORY_V1 ADD COLUMN pb_id TEXT;`);
        // TODO: add inxec unique for pb_id where pb_is is not null
        console.log("[DB Init] Added 'pb_id' column.");
    }
    if (!colNames.includes('pb_updated_at')) {
        db.exec(`ALTER TABLE CATEGORY_V1 ADD COLUMN pb_updated_at TEXT;`);
        console.log("[DB Init] Added 'pb_updated_at' column.");
    }
    if (!colNames.includes('pb_is_dirty')) {
        db.exec(`ALTER TABLE CATEGORY_V1 ADD COLUMN pb_is_dirty INTEGER DEFAULT 0;`);
        db.exec(`UPDATE CATEGORY_V1 SET pb_is_dirty = 1;`);
        console.log("[DB Init] Added 'pb_is_dirty' column and flagged existing records as dirty.");
    }
    if (!colNames.includes('pb_is_deleted')) {
        db.exec(`ALTER TABLE CATEGORY_V1 ADD COLUMN pb_is_deleted INTEGER DEFAULT 0;`);
        console.log("[DB Init] Added 'pb_is_deleted' column.");
    }

    // 2. Deterministic Static IDs for System Categories
    // We map existing records (where pb_id is NULL) to a deterministic 15-char ID compatible with PB.
    // e.g. CATEGID 1 becomes 'systemcat000001'
    const seedResult = db.prepare(`
        UPDATE CATEGORY_V1 
        SET pb_id = 'systemcat' || printf('%06d', CATEGID),
            pb_is_dirty = 1,
            pb_updated_at = STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'NOW')
        WHERE ( pb_id IS NULL OR pb_id = '' ) AND CATEGID < 100
    `).run();
    if (seedResult.changes > 0) {
        console.log(`[DB Init] Assigned Deterministic IDs to ${seedResult.changes} system/seed records.`);
    }

    // 3. Install Smart Triggers
    console.log("[DB Init] Ensuring Triggers exist...");

    db.exec(`
        CREATE TRIGGER IF NOT EXISTS TRG_CATEGORY_SYNC_INSERT
        AFTER INSERT ON CATEGORY_V1
        FOR EACH ROW
        WHEN NEW.pb_is_dirty IS NOT 2
        BEGIN
            UPDATE CATEGORY_V1 
            SET pb_is_dirty = 1, 
                pb_updated_at = STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'NOW')
            WHERE CATEGID = NEW.CATEGID;
        END;
    `);

    db.exec(`
        CREATE TRIGGER IF NOT EXISTS TRG_CATEGORY_SYNC_UPDATE
        AFTER UPDATE ON CATEGORY_V1
        FOR EACH ROW
        WHEN (
            (NEW.CATEGNAME IS NOT OLD.CATEGNAME OR NEW.ACTIVE IS NOT OLD.ACTIVE OR NEW.PARENTID IS NOT OLD.PARENTID)
            AND NEW.pb_is_dirty IS NOT 2
        )
        BEGIN
            UPDATE CATEGORY_V1 
            SET pb_is_dirty = 1, 
                pb_updated_at = STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'NOW')
            WHERE CATEGID = NEW.CATEGID;
        END;
    `);
}

/**
 * Push Phase: Local -> Cloud
 * Fetches all local records with pb_is_dirty = 1 and sends them to PocketBase.
 */
async function syncPush(db, pb) {
    console.log("\n[Push Phase] Starting...");
    const dirtyRecords = db.prepare(`SELECT * FROM CATEGORY_V1 WHERE pb_is_dirty = 1`).all();

    if (dirtyRecords.length === 0) {
        console.log("[Push Phase] No local changes to push.");
        return;
    }

    for (const record of dirtyRecords) {
        // fix for CATEGORY_V1 where parentid as -1 refer to root.
        if (record.PARENTID === -1) {
            record.PARENTID = 0;
        }
        // Construct PocketBase compatible payload
        const payload = {
            id: record.pb_id,          // Provide the deterministic ID so we don't duplicate on first push
            CATEGID: record.CATEGID,
            CATEGNAME: record.CATEGNAME,
            ACTIVE: record.ACTIVE,
            PARENTID: record.PARENTID,
            //            user: pb.authStore.model.id,
            updated_at: record.pb_updated_at,
            is_deleted: record.pb_is_deleted
        };
        //        console.log(payload);

        try {
            let remoteRecord;
            let existsInPb = false;

            if (record.pb_id) {
                try {
                    // Test if ID already exists on PocketBase
                    remoteRecord = await pb.collection(PB_COLLECTION).getOne(record.pb_id);
                    existsInPb = true;
                } catch (err) {
                    // Record doesn't exist yet remotely
                }
            }

            if (existsInPb) {
                // PATCH request
                remoteRecord = await pb.collection(PB_COLLECTION).update(record.pb_id, payload);
                console.log(`  -> Pushed UPDATE for local CATEGID: ${record.CATEGID} (Name: ${record.CATEGNAME}, ParentID: ${record.PARENTID})`);
            } else {
                // POST request
                remoteRecord = await pb.collection(PB_COLLECTION).create(payload);
                console.log(`  -> Pushed CREATE for local CATEGID: ${record.CATEGID} (Name: ${record.CATEGNAME}, ParentID: ${record.PARENTID})`);
            }

            // Acknowledge push by setting is_dirty back to 0 locally and updating ID constraints
            db.prepare(`
                UPDATE CATEGORY_V1 
                SET pb_is_dirty = 0, pb_id = ?
                WHERE CATEGID = ?
            `).run(remoteRecord.id, record.CATEGID);

        } catch (error) {
            console.error(`  -> [ERROR] Failed to push CATEGID ${record.CATEGID}:`, error.message);
        }
    }
}

/**
 * Pull Phase: Cloud -> Local
 * Fetches remote changes from PB and merges them into SQLite using Marker 2 (bypassing triggers).
 */
async function syncPull(db, pb) {
    console.log("\n[Pull Phase] Starting...");

    // 1. get last update. in prod use a stored variable in shared preferences 
    const lastUpdateRecord = db.prepare(`
        SELECT MAX(pb_updated_at) as last_sync 
        FROM CATEGORY_V1
        WHERE pb_updated_at IS NOT NULL
    `).get();
    // use 2 second sync windows
    let filterDate = "1970-01-01 00:00:00";

    if (lastUpdateRecord && lastUpdateRecord.last_sync) {
        // Trasforma in oggetto Date
        const date = new Date(lastUpdateRecord.last_sync);

        // Sottrai 2 secondi (2000 millisecondi)
        date.setSeconds(date.getSeconds() - 2);

        // Converti nel formato UTC richiesto da PocketBase (YYYY-MM-DD HH:MM:SS)
        // Usiamo .replace per pulire il formato .toISOString()
        filterDate = date.toISOString().replace('T', ' ').split('.')[0];
    }
    console.log("retrive from:", filterDate);

    // We need to retrive record since last update. for POC we fetch record starting from max pb_update_at
    let records = [];
    try {
        records = await pb.collection(PB_COLLECTION).getFullList({
            sort: '-updated', // get newest records first
            filter: `updated >= "${filterDate}"`,
        });
    } catch (error) {
        console.error("  -> [ERROR] Failed to fetch from PocketBase:", error.message);
        return;
    }

    if (records.length === 0) {
        console.log("[Pull Phase] No remote records to pull.");
        return;
    }

    // Wrap Database updates in a Transaction to safely process all pulled records at once
    const processRemoteRecord = db.transaction((rmt) => {
        //console.log(rmt);
        // fix for CATEGORY_V1 where parentid as -1 refer to root.
        if (rmt.PARENTID === 0) {
            rmt.PARENTID = -1;
        }
        const local = db.prepare(`SELECT * FROM CATEGORY_V1 WHERE pb_id = ?`).get(rmt.id);

        // Safety check to ensure we match JS types expected by SQLite
        const isDeleted = rmt.pb_is_deleted ? 1 : 0;

        if (local) {
            // Found matched ID -> perform Marker Update
            db.prepare(`
                UPDATE CATEGORY_V1 
                SET CATEGNAME = ?, ACTIVE = ?, PARENTID = ?, 
                    pb_updated_at = ?, pb_is_deleted = ?,
                    pb_is_dirty = 2
                WHERE pb_id = ?
            `).run(rmt.CATEGNAME, rmt.ACTIVE, rmt.PARENTID, rmt.updated, isDeleted, rmt.id);

            // Compatibility Rule Application (e.g. if deleted remotely, ensure local native ACTIVE field responds)
            if (isDeleted) {
                db.prepare(`UPDATE CATEGORY_V1 SET ACTIVE = 0 WHERE pb_is_dirty = 2 AND pb_id = ?`).run(rmt.id);
                // IF DELETED TIME field existed, we'd also update it here as per POC doc step 2.b
            }
            console.log(`  <- Pulled UPDATE for pb_id: ${rmt.id}`);
        } else {
            // New ID remotely -> insert locally
            const pbCatID = rmt.CATEGID || null;

            const insertStmt = pbCatID
                ? db.prepare(`
                    INSERT INTO CATEGORY_V1 (CATEGID, CATEGNAME, ACTIVE, PARENTID, pb_id, pb_updated_at, pb_is_deleted, pb_is_dirty)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 2)
                `)
                : db.prepare(`
                    INSERT INTO CATEGORY_V1 (CATEGNAME, ACTIVE, PARENTID, pb_id, pb_updated_at, pb_is_deleted, pb_is_dirty)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 2)
                `);

            if (pbCatID) {
                insertStmt.run(pbCatID, rmt.CATEGNAME, rmt.ACTIVE, rmt.PARENTID, rmt.id, rmt.updated, isDeleted);
            } else {
                insertStmt.run(rmt.CATEGNAME, rmt.ACTIVE, rmt.PARENTID, rmt.id, rmt.updated, isDeleted);
            }
            console.log(`  <- Pulled INSERT for pb_id: ${rmt.id}`);
        }
    });

    for (const rmt of records) {
        processRemoteRecord(rmt);
    }

    // Step 3: Batch Cleanup (Final step of marker logic)
    console.log("  -> Running Marker Cleanup...");
    db.prepare(`UPDATE CATEGORY_V1 SET pb_is_dirty = 0 WHERE pb_is_dirty = 2`).run();
    console.log("  -> Cleanup complete.");
}

async function main() {
    console.log("==========================================");
    console.log("    🚀 MMEX Node.js Sync Engine POC");
    console.log("==========================================");
    let db;
    try {
        db = new Database(DB_PATH);
    } catch (err) {
        console.error(`[FATAL] Failed to open SQLite db at ${DB_PATH}. Does file exist?`);
        console.error("  Error:", err.message);
        process.exit(1);
    }

    const pb = new PocketBase(PB_URL);

    try {
        console.log(`[Auth] Authenticating to PocketBase at ${PB_URL} as ${PB_USER}...`);
        // use this for admin passwrod
        await pb.admins.authWithPassword(PB_USER, PB_PASS);
        // use this for user password
        // await pb.collection('users').authWithPassword(PB_USER, PB_PASS);
        console.log("[Auth] Success.");

        // 1. Initialize schema & triggers
        initDB(db);

        // 2. Perform remote push of local changes
        await syncPush(db, pb);

        // 3. Perform pull of remote changes
        await syncPull(db, pb);

        console.log("\n✅ Sync sequence completed successfully!");
    } catch (err) {
        console.error("\n❌ [Sync Failed] Error details:", err);
    } finally {
        if (db) db.close();
        console.log("Database connection closed.");
    }
}

// Execute logic
main();
