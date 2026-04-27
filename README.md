# MMEX Sync Engine POC (Sidecar Architecture)

> [!WARNING]
> This is a POC, not production-ready code.
> still not work perfectly

![Money Manager Ex Sync - Record-Level Safe Sync Banner](assets/images/mmex-sync-banner.png)

## Overview
This Proof of Concept (POC) demonstrates a non-intrusive, "Offline-First" synchronization system for Money Manager Ex (MMEX). The goal is to enable seamless multi-device sync (Windows <-> Cloud <-> Android) without requiring any changes to the existing MMEX C++ desktop codebase.

## Video
**Demo Video between Windows & Android**
[Demo Video between Windows & Android🤩](https://drive.google.com/file/d/1pKFcdcNuf47BQDFQAtPBOCC_B_BfgwxF/view)


**Demo Video between two Windows**
[Demo Video between two Windows🤩](https://1drv.ms/v/c/6958bccc4c47c1d3/IQAfDCUauF7dQo2GL1r47SziAfLlgfXdpo8-8-ustZM9CMA?e=5mPJBo)


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
To track changes without modifying the MMEX source code, this POC utilizes **SQLite Triggers**. These triggers automatically flag records for synchronization (`pb_is_dirty` flag or filling `pb_DELETED_RECORDS_LOG` table) when a user performs an Insert, Update or Delete within the desktop app. All the operations are managed in a transparent way for application.

### 3. Loop Protection (3-State Protocol)
To prevent infinite synchronization loops (where the Sync Engine's own updates trigger a new sync request), we implement a three-state logic:
- **`0` (Synced):** Data is up-to-date with the cloud.
- **`1` (Local Change):** User modified data; needs to be pushed to the cloud.
- **`2` (Cloud Ingress):** Sync Engine is writing data from the cloud; **Triggers ignore these operations.**

## Database Schema Extensions
The POC adds technical columns to the all tables:
- `pb_id`: Unique PocketBase identifier.
- `pb_updated_at`: ISO8601 timestamp from the server.
- `pb_is_dirty`: State flag (0, 1, or 2).
A table is also added to track deletion of records: `pb_DELETED_RECORDS_LOG` via trigger.

## 🛠️ Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/wolfsolver/money_manager_ex_sync_poc.git
   cd money_manager_ex_sync_poc
   ```

2. **Install dependencies**:
   This project uses `better-sqlite3` for database interaction and the official `pocketbase` SDK.
   ```bash
   npm install
   ```

## 🚀 Usage

You can run the sync engine by providing configuration via command-line arguments or environment variables.

### Command Line Parameters
```bash
Options:
  --db=<path>       Path to the local SQLite database (default: ./sample_db.mmb)
  --url=<url>       PocketBase server URL (default: http://127.0.0.1:8090)
  --user=<email>    PocketBase admin email
  --pass=<password> PocketBase admin password
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
 
```

### Using Command Line Arguments (Recommended)
```bash
node sync.js --db="./my_database.mmb" --user="admin@example.com" --pass="YourPassword" --url="http://127.0.0.1:8090"
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


## Project Structure
Root
- `sync_core.js`: The main logic for the Sync Engine.
- `table_v1.sql`: The SQL schema for the Sync Engine.
- `table_v1_for_sync.sql`: The SQL schema for the Sync Engine without default records.
- `config/table_config.js` configure table and fields 

tests
- `db_sample_1`: sample database 1
- `db_sample_2`: sample database 2
- `mytest_core.bat`: The test script for the Sync Engine.


## 🧪 Quick Start: Testing the Sync (Step-by-Step)

### 1. Configure Credentials
Create a file named `set_user_passwd.bat` in the root project folder with your PocketBase user and password:
```bat
set PB_USER=your_user
set PB_PASS=your_password
```

### 2. Initialize the databases
Run `clean_test.bat` to have two empty databases, on db1 as sample empy db from money manager ex, on db2 a modified copy only with structure (not with defulet transaction), ad remove all data from pocketbase instance.
```bash
clean_test.bat
```

### 3. Sync the databases
on db_sample_1 older run `mytest_core.bat`. This add new column and table (--init), push from local to remote (--push), pull from remote to local (--pull)
```bash
db_sample_1\mytest_core.bat
```
or if you prefer
```bash
db_sample_1\mytest_core.bat --init
db_sample_1\mytest_core.bat --push
db_sample_1\mytest_core.bat --pull
```

On db_sample_2 do the same 
```bash
db_sample_2\mytest_core.bat
```

### 4. Play with MMEX
- open MMEX for db1 and add a transaction
- run `mytest_core.bat` for both databases
- see result with check on MMEX db1 and db2

### 5. Validate synchronization (optional)
Check with `myverify.bat` to validate thate db are idntical (structure and content)
```bash
myverify.bat
```

## Conclusion
This architecture proves that MMEX can be modernized with cloud capabilities while remaining a stable, offline-first desktop software. It respects the existing codebase and provides a modular path forward for the community.
