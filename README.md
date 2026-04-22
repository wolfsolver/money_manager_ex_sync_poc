# MMEX Sync Engine POC (Sidecar Architecture)

> [!WARNING]
> This is a POC, not production-ready code.
> still not work perfectly

## Overview
This Proof of Concept (POC) demonstrates a non-intrusive, "Offline-First" synchronization system for Money Manager Ex (MMEX). The goal is to enable seamless multi-device sync (Windows <-> Cloud <-> Android) without requiring any changes to the existing MMEX C++ desktop codebase.

### ⚠️ IMPORTANT: DISCLAIMER & WARNING

**This is a Proof of Concept (POC).** This software is provided for **educational and testing purposes only**. It is **NOT** intended for use with real, production, or important financial databases.

* **No Warranty:** This code is provided "as is" without any warranty of any kind. 
* **Liability:** The author(s) decline any responsibility for data loss, database corruption, or financial discrepancies resulting from the use of this software.
* **Safety First:** Always use a **copy** of your database (e.g., `sample_db.mmb`) for testing.

> **Funny Warning:**
> Using this script on your primary financial database is a great way to discover your inner "minimalist" by accidentally deleting your entire net worth. If your bank account suddenly looks as empty as a fridge on a Monday morning, don't say we didn't warn you! 💸🔥

### Additional info file
- [README_POCKETBASE.md](README_POCKETBASE.md): Pocketbase setup 
- [task_list.md](task_list.md): task list for the POC

## Key Concepts

### 1. The "Sidecar" Approach
The Sync Engine runs as an optional, external process (Sidecar). It observes the MMEX database and handles communication with a PocketBase backend. If the Sync Engine is not running, MMEX continues to operate as a standard local application.

### 2. Zero-Impact Integration (SQLite Triggers)
To track changes without modifying the MMEX source code, this POC utilizes **SQLite Triggers**. These triggers automatically flag records for synchronization (`pb_is_dirty` flag) whenever a user performs an Insert or Update within the desktop app.

### 3. Loop Protection (3-State Protocol)
To prevent infinite synchronization loops (where the Sync Engine's own updates trigger a new sync request), we implement a three-state logic:
- **`0` (Synced):** Data is up-to-date with the cloud.
- **`1` (Local Change):** User modified data; needs to be pushed to the cloud.
- **`2` (Cloud Ingress):** Sync Engine is writing data from the cloud; **Triggers ignore these operations.**

## Database Schema Extensions
The POC adds technical columns to the `CATEGORY_V1` table:
- `pb_id`: Unique PocketBase identifier.
- `pb_updated_at`: ISO8601 timestamp from the server.
- `pb_is_dirty`: State flag (0, 1, or 2).
- `pb_is_deleted`: Soft-delete flag.

## 🛠️ Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone [https://github.com/your-username/mmex-sync-poc.git](https://github.com/your-username/mmex-sync-poc.git)
   cd mmex-sync-poc
   ```

2. **Install dependencies**:
   This project uses `better-sqlite3` for database interaction and the official `pocketbase` SDK.
   ```bash
   npm install
   ```

## 🚀 Usage

You can run the sync engine by providing configuration via command-line arguments or environment variables.

### Using Command Line Arguments (Recommended)
```bash
node sync.js --db="./my_database.mmb" --user="admin@example.com" --pass="YourPassword" --url="[http://127.0.0.1:8090](http://127.0.0.1:8090)"
```

### Using Environment Variables
Alternatively, you can set environment variables before running the script:
- `DB_PATH`: Path to your `.mmb` file.
- `PB_USER`: PocketBase admin email.
- `PB_PASS`: PocketBase admin password.
- `PB_URL`: PocketBase instance URL.

### Synchronization Flow
1. **Initialization:** On the first run, the script automatically adds the necessary columns and installs the SQLite triggers.
2. **Push Phase:** Local changes (flagged with `pb_is_dirty = 1`) are sent to PocketBase.
3. **Pull Phase:** The script fetches records updated since the last local sync and merges them into SQLite.

## ⚠️ Important Implementation Details
- **Deterministic IDs:** To prevent duplicates during the initial sync, default system categories are assigned static IDs (e.g., `systemcat000001`).
- **ParentID Mapping:** The engine automatically handles the mapping between MMEX root IDs (`-1`) and PocketBase-compatible IDs (`0`).

## Project Structure
- `sync.js`: The main logic for the Sidecar engine.
- `README.md`: Project documentation.

## Conclusion
This architecture proves that MMEX can be modernized with cloud capabilities while remaining a stable, offline-first desktop software. It respects the existing codebase and provides a modular path forward for the community.

## Internal Note
- sync category work
- sync massive has issue.... 