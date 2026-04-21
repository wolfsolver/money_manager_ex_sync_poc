# PocketBase Configuration for MMEX Sync POC

To test the POC, you need a PocketBase instance configured with the correct collection and permissions.

## 0. setup

1. Download PocketBase from [PocketBase website](https://pocketbase.io/) (chose your distribution)
2. Run pocketbase serve
3. Open your PocketBase Admin UI (usually `http://127.0.0.1:8090/_/`).
4. Create first adminuser

## 1. Fast Setup (Import Schema)
1. Open your PocketBase Admin UI (usually `http://127.0.0.1:8090/_/`).
2. Go to **Settings** > **Import collections**.
3. Paste the contents of `pb_schema.json` (found in this folder) into the JSON field.
4. Click **Review** and then **Import**.

## 2. Manual Setup (If preferred)
If you want to create it manually, ensure the collection `CATEGORY_V1` has the following fields:
- `CATEGID` (Number)
- `CATEGNAME` (Text)
- `ACTIVE` (Number)
- `PARENTID` (Number)

## 3. API Rules (Security)
For the POC is not implemented, but Pocketbase support multi users. In this case change: 
    `await pb.admins.authWithPassword(PB_USER, PB_PASS);`
to
    `await pb.collection('users').authWithPassword(PB_USER, PB_PASS);`


## 4. Test Records
- From MMEX change a category record in db1
  - node sync.js --user=... --pass=.... --db=.\sample_db1.mmb
  - node sync.js --user=... --pass=.... --db=.\sample_db2.mmb
  - see result from MMEX opening db2
- From MMEX create new record in db1 (this as no systemcat id)
  - node sync.js --user=... --pass=.... --db=.\sample_db1.mmb
  - node sync.js --user=... --pass=.... --db=.\sample_db2.mmb
  - see result from MMEX opening db2
  - change a record crom db2
  - node sync.js --user=... --pass=.... --db=.\sample_db2.mmb
  - node sync.js --user=... --pass=.... --db=.\sample_db1.mmb
  - see result from MMEX opening db1
  
