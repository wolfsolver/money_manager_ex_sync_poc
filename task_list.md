## Main list

- [x] Add a mechanism to store compatible dB user version and prevent sync is is different
- [X] Add switch from command line to execute a single step (init, push, pull)
- [X] Rename sync.js into sync_sample.js. (three model: sync_sample only category, sync_core main transacion table, sync_full all table
- [X] add new switch "--clearServer" to clear all pocketbase data in application table (not in system table)

## Future Development (Project Extension)

- [ ] **Completing Deletion Logic (Pull & Cleanup)**
  - **Inbound Deletion (Pull)**: Update the `syncPull` function to check the `is_deleted` flag from PocketBase. If a remote record is marked as deleted, the engine must physically delete the corresponding record from the local SQLite database.
  - **Local Cleanup (Post-Push)**: Implement a physical cleanup of local records marked with `pb_is_deleted = 1` only after receiving a successful confirmation from the PocketBase server during the `syncPush` phase.

- [ ] **Deletion Management (ON DELETE Tracking)**
  - Create a technical log table (e.g., `DELETED_RECORDS_LOG`) to store the `table_name` and `primary_key` of removed records.
  - Implement `AFTER DELETE` triggers on all synchronized tables to populate this log.
  - Update the `syncPush` logic to send delete requests to the server based on this log, ensuring the remote database reflects local deletions without using "soft-delete" in the main tables.

- [ ] **Attachment Integration (Attachment Management)**
  - Map the MMEX attachments table to the sync engine.
  - Implement file upload/download to PocketBase using its native storage system.
  - Ensure a bi-directional association between local files and cloud records.

- [ ] **Complete Database Schema Mapping**
  - Audit all remaining MMEX tables (e.g., `CURRENCYFORMATS_V1`, `BUDGET`, etc.).
  - Fully map all fields for every table within the `SYNC_CONFIG` configuration.
  - Verify Foreign Key hierarchies to ensure the correct synchronization order for all tables.

- [ ] **Conflict Resolution (Simplified Policy)**
  - Implement a "Last Write Wins" logic to handle simultaneous modifications across different devices simply and effectively.