# Progetto: MMEX-Sync (da Node.js a MSI)
**Obiettivo:** Trasformare il POC Node.js in un'applicazione Windows standalone (`.exe`) e pacchettizzarla in un installer (`.msi`).

## 1. Architettura e Requisiti Tecnici
* **Engine:** Node.js 20+ con Single Executable Application (SEA).
* **Moduli Critici:** `better-sqlite3` (modulo nativo C++), `keytar` (per Windows Credential Manager).
* **UI:** CLI interattiva (usando `enquirer` o `prompts`).
* **Persistence:** Salvataggio configurazione in `%AppData%/mmex-sync/config.json`.
* **Security:** Password/Token salvati tramite `keytar` nel Credential Manager di Windows.

## 2. Roadmap di Implementazione

### Fase A: Preparazione del Codice (`sync.js`)
1.  **UI di Benvenuto:** Se il file di config non esiste o il token è invalido, richiedi:
    * URL PocketBase
    * Username/Password
    * Path `mmex.exe` (es. `C:\Program Files\MMEX\mmex.exe`)
    * Path file `.mmb` del database.
2.  **Gestione Token:** Dopo il primo login, salva l'auth token in modo sicuro con `keytar`.
3.  **Workflow Esecuzione:**
    * controlla di avere accesso al file exe e al fil mmb e al sistema remoto (tocken valido). se no avvia la ui di benvenuto.
    * Esegui `sync_core.js` (Pull).
    * Avvia `mmex.exe` come processo figlio (`spawn`) e attendi la chiusura (`close` event).
    * Esegui `sync_core.js` (Push) al termine.

### Fase B: Bundling & SEA (Single Executable)
1.  **Bundling con esbuild:** Unire tutti i file JS in `dist/bundle.js`.
    * **Importante:** Escludere `better-sqlite3` dal bundle (segnarlo come `external`) poiché i file `.node` non possono essere inclusi nell'eseguibile SEA.
2.  **Configurazione SEA:** Creare `sea-config.json` puntando a `dist/bundle.js`.
3.  **Iniezione Blob:** * Generare il blob con `node --experimental-sea-config`.
    * Copiare `node.exe` in `mmex-sync.exe`.
    * Iniettare il blob usando `postject`.

### Fase C: Struttura Cartella di Distribuzione
Prima di creare l'MSI, la cartella `dist/` deve contenere:
* `mmex-sync.exe` (il core dell'app).
* `better_sqlite3.node` (il file binario compilato, estratto da `node_modules/better-sqlite3/build/Release`).
* Tutte le DLL necessarie per `better-sqlite3` e `keytar`.

### Fase D: Creazione Installer MSI
Usare uno strumento come **WiX Toolset** o **Advanced Installer** per:
1.  Definire la cartella di installazione (default: `C:\Program Files\MMEX-Sync`).
2.  Creare un collegamento sul Desktop e nel Menu Start che punti a `mmex-sync.exe`.
3.  Impostare le icone personalizzate.
4.  Configurare i permessi di scrittura per la cartella in `%AppData%` (non nella cartella d'installazione).

---

## 3. Comandi Chiave per l'Agente
* **Build Bundle:** `npx esbuild sync.js --bundle --platform=node --target=node20 --external:better-sqlite3 --outfile=dist/bundle.js`
* **Genera Blob SEA:** `node --experimental-sea-config sea-config.json`
* **Iniezione (PowerShell):** `npx postject mmex-sync.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_f1422af715635223`

## 4. Note per il Debug
* Testare sempre l'eseguibile in una cartella pulita (senza `node_modules`) per verificare che il file `.node` di SQLite venga caricato correttamente.
* Assicurarsi che l'app gestisca correttamente i percorsi Windows con spazi (es. `C:\Program Files\...`).