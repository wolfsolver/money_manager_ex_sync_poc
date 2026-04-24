## Main list

- [x] Add a mechanism to store compatible dB user version and prevent sync is is different
- [X] Add switch from command line to execute a single step (init, push, pull)
- [X] Rename sync.js into sync_sample.js. (three model: sync_sample only category, sync_core main transacion table, sync_full all table)
- [X] add new switch "--clearServer" to clear all pocketbase data in application table (not in system table)

## Future Development (Project Extension)

- [x] **Handle last sync time stamp**
      Use this as value to sync only newer records from pocketbase to local db during pull phase. 
      Value is set as time stime execution of last pulling operation.
      store this not in  table but in a file in local folder "sync_data" with name .lastsync . add this file to .gitignore (never upload to git)

- [x] **Complete Database Schema Mapping**
  - Audit all remaining MMEX tables (e.g., `CURRENCYFORMATS_V1`, `BUDGET`, etc.).
  - Fully map all fields for every table within the `SYNC_CONFIG` configuration.
  - Verify Foreign Key hierarchies to ensure the correct synchronization order for all tables.

- [x] **Completing Deletion Logic (Pull & Cleanup)**
  - **Inbound Deletion (Pull)**: Update the `syncPull` function to check the `is_deleted` flag from PocketBase. If a remote record is marked as deleted, the engine must physically delete the corresponding record from the local SQLite database.
  - **Local Cleanup (Post-Push)**: Implement a physical cleanup of local records marked with `pb_is_deleted = 1` only after receiving a successful confirmation from the PocketBase server during the `syncPush` phase.

- [x] **Deletion Management (ON DELETE Tracking)**
  - Create a technical log table (e.g., `pb_DELETED_RECORDS_LOG`) to store the `table_name` and `primary_key` of removed records.
  - Implement `AFTER DELETE` triggers on all synchronized tables to populate this log.
  - Update the `syncPush` logic to send delete requests to the server based on this log, ensuring the remote database reflects local deletions without using "soft-delete" in the main tables.

- [ ] **Attachment Integration (Attachment Management)**
  - Map the MMEX attachments table to the sync engine.
  - Implement file upload/download to PocketBase using its native storage system.
  - Ensure a bi-directional association between local files and cloud records.

- [ ] **Conflict Resolution (Simplified Policy)**
  - Implement a "Last Write Wins" logic to handle simultaneous modifications across different devices simply and effectively.

- [ ] **Real-time Service Mode (`--watch`)**
  - [X] **Lock during sync**: Lock db while push and pulling to prevent db corruption.
  - [X] **Local Watcher**: Implement `chokidar` (or native `fs.watch`) to monitor the `.mmb` file. Trigger a `syncPush` immediately when MMEX saves changes to the database. if DB is `SQLITE_BUSY`, wait and retry.
  - [X] **Remote Watcher (PocketBase Realtime)**: Use the `pb.collection(table).subscribe('*', ...)` feature to listen for remote changes. This replaces periodic pulling with instantaneous updates.
  - [ ] **Concurrency Handling**: Implement a "debounce" mechanism to prevent multiple syncs from firing simultaneously if the file is saved multiple times in a few seconds.
  
- [ ] **Android Integration Strategy**
  - [ ] **Mobile Client Research**: Evaluate the current MMEX Android codebase to identify the best injection point for the PocketBase sync logic.
  - [ ] **Kotlin/Java Implementation**: Port the logic from `sync_core.js` (Deterministic IDs, dirty flags, and triggers) to the Android SQLite implementation.
  - [ ] **Offline-First for Mobile**: Ensure the Android app handles intermittent connectivity by queueing local changes and syncing them once the device is back online, mirroring the Sidecar's behavior.

- [ ] check if is possible to update directly on pocket base the user field while a record is created/updated using Auth 
