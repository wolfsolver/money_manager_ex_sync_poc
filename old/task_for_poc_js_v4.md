# Technical Proposal: Non-Intrusive Cloud Sync Engine for MMEX

## 1. Executive Summary
The goal of this proposal is to introduce an **optional** cloud synchronization layer for Money Manager Ex without modifying the existing C++/wxWidgets or Java/Android core logic. By using **SQLite Triggers** and a **Sidecar Sync Engine**, we can transform MMEX into an "Offline-First Cloud" application.

## 2. The "Three-State" Sync Protocol (`pb_is_dirty`)
To ensure data integrity and avoid infinite loops between local and remote updates, we implement a 3-state flag system:
- **`0` (Synced):** Local and Cloud data are identical.
- **`1` (Local Change):** Modified by the user via MMEX; needs to be pushed to the Cloud.
- **`2` (Cloud Ingress):** The Sync Engine is currently writing data received from the Cloud. **Triggers must ignore these changes.**

## 3. Database Schema Extensions
The following technical columns must be added to the tables (starting with `CATEGORY_V1` for the POC):
- `pb_id` (TEXT): The unique identifier from PocketBase.
- `pb_updated_at` (TEXT): ISO8601 timestamp of the last modification.
- `pb_is_dirty` (INTEGER): State flag (0,1,1).
- `pb_is_deleted` (INTEGER): boolean flag (0 = not deleted, 1 = deleted).

**Note 1** if is_deleted is 1 end in table there is a ACTIVE field, this need to be set to zero. 
**Note 2** if is_deleted is 1 and in table there is a DELETEDTIME field, this need to be set to updated_at. 

### 3.1 Preventing Duplication of System Records
To avoid duplicates when a user starts a new database or syncs for the first time, "Seed" categories (e.g., Food, Salary, Bills) are assigned a **Deterministic Static ID**.
- Example: `CATEGID: 1` (Food) is mapped to `pb_id: "systemcat000001"`.
- This ensures that multiple devices will "merge" into the same cloud record instead of creating clones.

## 4. SQLite Triggers (The "Smart" Engine)
These triggers are installed once and act as an automated observer.

> **Implementation Flexibility:**
> While this POC utilizes SQLite Triggers to capture changes non-intrusively, the architecture is not strictly dependent on them. In a future production release, the core application could natively manage the is_dirty and updated_at fields during its standard database write operations. Triggers are currently employed to bridge the gap between the existing legacy code and the new synchronization requirements.

### A. Insert Trigger
Flags any new record created by the user for synchronization.
```sql
CREATE TRIGGER IF NOT EXISTS TRG_CATEGORY_SYNC_INSERT
AFTER INSERT ON CATEGORY_V1
BEGIN
    UPDATE CATEGORY_V1 
    SET pb_is_dirty = 1, 
        pb_updated_at = STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'NOW')
    WHERE CATEGID = NEW.CATEGID;
END;
```

### B. Update Trigger (With Loop Protection)
Only triggers if "real" data changes and the change is NOT coming from the Sync Engine (`pb_is_dirty <> 2`).
```sql
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
```

---

## 5. POC Sync Engine Logic (Node.js Sidecar)
The POC is a standalone script that the user runs on-demand.

### Phase 1: Push (Local -> Cloud)
1. Select all records where `pb_is_dirty = 1`.
2. Perform `POST` (if `pb_id` is null) or `PATCH` (if `pb_id` exists) to PocketBase.
3. On success, set `pb_is_dirty = 0`.

### Phase 2: Pull (Cloud -> Local)
1. Fetch records from PocketBase modified since the last sync.
2. Update the local SQLite table using the **Marker Strategy**:
   ```sql
   UPDATE CATEGORY_V1 
   SET CATEGNAME = ?, ACTIVE = ?, pb_id = ?, 
       pb_is_dirty = 2 -- Temporarily bypasses the trigger
   WHERE CATEGID = ?;
   ```
2.a. **ACTIV FIELD COMPATIBILITY:** `UPDATE CATEGORY_V1 SET ACTIVE = 0 WHERE pb_is_dirty = 2 AND pb_deleted = 1;`
2.b. CATEGORY_V1 has no DELETETIME FIELD. IF table ash DELETE TIME we beed to **DELETEDTIME FIELD COMPATIBILITY:** `UPDATE CATEGORY_V1 SET DELETEDTIME = pb_updated_at WHERE pb_is_dirty = 2 AND pb_deleted = 1;`
3. **Batch Cleanup:** `UPDATE CATEGORY_V1 SET pb_is_dirty = 0 WHERE pb_is_dirty = 2;`

---

## 6. Proof of Concept (POC) Demonstration Steps
1. **Initial Setup:** Run the script to install triggers and technical columns.
2. **Local Test:** Change a category name in MMEX Desktop. Run the script. Verify the change on PocketBase.
3. **Remote Test:** Change a category name on the PocketBase Dashboard. Run the script. Open MMEX and verify the update.
4. **Collision Test:** Show how the deterministic IDs for system categories prevent duplication.

## 7. Conclusion for the Core Team
This approach requires **zero changes** to the existing MMEX C++ codebase. It treats the database as an intelligent entity that tracks its own changes, allowing external modules to handle the complex networking and synchronization logic.