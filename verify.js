const Database = require('better-sqlite3');

// ==========================================
// CONFIGURATION & ARGUMENTS
// ==========================================
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.split('=');
    const cleanKey = key.replace('--', '');
    acc[cleanKey] = value !== undefined ? value : true;
    return acc;
}, {});

if (args.help || !args.db1 || !args.db2) {
    console.log(`
Usage: node verify.js --db1=<path_to_db1> --db2=<path_to_db2>

Description:
  Compares two MMEX databases to find differences in synchronized tables.
  Checks for:
  - Missing records (based on pb_id)
  - Differences in field values
    `);
    process.exit(0);
}

// Configurazione speculare a sync_core.js per sapere cosa confrontare
const SYNC_CONFIG = {
    'INFOTABLE_V1': { pk: 'INFOID', fields: ['INFONAME', 'INFOVALUE'] },
    'CATEGORY_V1': { pk: 'CATEGID', fields: ['CATEGNAME', 'ACTIVE', 'PARENTID'] },
    'PAYEE_V1': { pk: 'PAYEEID', fields: ['PAYEENAME', 'ACTIVE', 'CATEGID'] },
    'ACCOUNTLIST_V1': { pk: 'ACCOUNTID', fields: ['ACCOUNTNAME', 'ACCOUNTTYPE', 'STATUS', 'FAVORITEACCT', 'INITIALDATE', 'INITIALBAL', 'CURRENCYID'] },
    'CHECKINGACCOUNT_V1': { pk: 'TRANSID', fields: ['ACCOUNTID', 'TOACCOUNTID', 'PAYEEID', 'TRANSCODE', 'TRANSAMOUNT', 'STATUS', 'CATEGID', 'TRANSDATE', 'NOTES'] },
    'BILLSDEPOSITS_V1': { pk: 'BDID', fields: ['ACCOUNTID', 'PAYEEID', 'TRANSCODE', 'TRANSAMOUNT', 'CATEGID', 'NEXTOCCURRENCEDATE'] }
};

function verify() {
    const db1 = new Database(args.db1);
    const db2 = new Database(args.db2);

    console.log(`\n🔍 Comparing DB1: ${args.db1} | DB2: ${args.db2}\n`);

    for (const [tableName, config] of Object.entries(SYNC_CONFIG)) {
        console.log(`--- Table: ${tableName} ---`);

        // 1. Carichiamo tutti i record usando pb_id come chiave universale
        const records1 = db1.prepare(`SELECT * FROM ${tableName} WHERE pb_id IS NOT NULL`).all();
        const records2 = db2.prepare(`SELECT * FROM ${tableName} WHERE pb_id IS NOT NULL`).all();

        const map2 = new Map(records2.map(r => [r.pb_id, r]));
        let tableIssues = 0;

        // 2. Verifica da DB1 a DB2
        records1.forEach(row1 => {
            const row2 = map2.get(row1.pb_id);

            if (!row2) {
                console.warn(`  ❌ Missing in DB2: pb_id ${row1.pb_id} (${config.pk}: ${row1[config.pk]})`);
                tableIssues++;
                return;
            }

            // Confronto campi
            config.fields.forEach(field => {
                let val1 = row1[field];
                let val2 = row2[field];

                // Normalizzazione per confronto (es. date o null)
                if (val1 !== val2) {
                    console.warn(`  ⚠️  Difference in pb_id ${row1.pb_id}: Field [${field}] | DB1: '${val1}' vs DB2: '${val2}'`);
                    tableIssues++;
                }
            });
        });

        // 3. Verifica record extra in DB2
        const map1 = new Map(records1.map(r => [r.pb_id, r]));
        records2.forEach(row2 => {
            if (!map1.has(row2.pb_id)) {
                console.warn(`  ❌ Extra in DB2: pb_id ${row2.pb_id} (${config.pk}: ${row2[config.pk]})`);
                tableIssues++;
            }
        });

        if (tableIssues === 0) {
            console.log(`  ✅ OK: All records match.`);
        } else {
            console.log(`  Summary: Found ${tableIssues} issues.`);
        }
        console.log("");
    }

    db1.close();
    db2.close();
}

verify();
