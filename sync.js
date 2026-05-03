import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import enquirer from 'enquirer';
import PocketBase from 'pocketbase';
import { protect, unprotect } from './dpapi.js';
import { setSyncConfig, runSyncCycle } from './sync_core.js';

const CONFIG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'mmex-sync');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

async function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
            return JSON.parse(raw);
        } catch (e) {
            console.error("Error reading config.json:", e.message);
            return null;
        }
    }
    return null;
}

function saveConfig(config) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function promptUser() {
    console.log("=== Configurazione MMEX-Sync ===");
    const questions = [
        {
            type: 'input',
            name: 'pbUrl',
            message: 'PocketBase URL (es. http://127.0.0.1:8090):',
            initial: 'http://127.0.0.1:8090'
        },
        {
            type: 'input',
            name: 'pbUser',
            message: 'PocketBase Email:'
        },
        {
            type: 'password',
            name: 'pbPass',
            message: 'PocketBase Password:'
        },
        {
            type: 'input',
            name: 'mmexExe',
            message: 'Percorso mmex.exe:',
            initial: 'C:\\Program Files\\MoneyManagerEx\\bin\\mmex.exe'
        },
        {
            type: 'input',
            name: 'dbPath',
            message: 'Percorso database .mmb:'
        }
    ];

    const answers = await enquirer.prompt(questions);

    // Test di connessione e acquisizione token
    console.log("Verifica credenziali in corso...");
    try {
        const pb = new PocketBase(answers.pbUrl);
        await pb.collection('users').authWithPassword(answers.pbUser, answers.pbPass);
        
        const token = pb.authStore.token;
        const encryptedToken = protect(token);

        const config = {
            pbUrl: answers.pbUrl,
            pbUser: answers.pbUser,
            mmexExe: answers.mmexExe,
            dbPath: answers.dbPath,
            token: encryptedToken
        };

        saveConfig(config);
        console.log("✅ Configurazione salvata con successo!");
        return config;

    } catch (e) {
        console.error("❌ Errore di autenticazione:", e.message);
        process.exit(1);
    }
}

async function main() {
    let config = await loadConfig();

    if (!config || !config.token) {
        config = await promptUser();
    }

    const token = unprotect(config.token);
    if (!token) {
        console.log("Token non valido o scaduto, ripetiamo il login.");
        config = await promptUser();
    }

    // Impostiamo la configurazione per sync_core
    setSyncConfig({
        url: config.pbUrl,
        user: config.pbUser,
        token: unprotect(config.token),
        db: config.dbPath,
        config_file: path.join(CONFIG_DIR, '.lastsync'),
        pull: true,
        push: false,
        init: true // assicura che il DB sia inizializzato se è il primo run
    });

    console.log("\n=== Avvio Fase di Pull ===");
    await runSyncCycle();

    console.log(`\n=== Avvio MMEX: ${config.mmexExe} ===`);
    if (!fs.existsSync(config.mmexExe)) {
        console.error(`❌ Errore: file eseguibile MMEX non trovato in ${config.mmexExe}`);
        process.exit(1);
    }

    // Lanciamo MMEX e aspettiamo la chiusura
    const mmexProcess = spawn(config.mmexExe, [config.dbPath], {
        detached: false,
        stdio: 'inherit'
    });

    mmexProcess.on('close', async (code) => {
        console.log(`\n=== MMEX chiuso (Codice ${code}). Avvio Fase di Push ===`);
        
        setSyncConfig({
            url: config.pbUrl,
            user: config.pbUser,
            token: unprotect(config.token),
            db: config.dbPath,
            config_file: path.join(CONFIG_DIR, '.lastsync'),
            pull: false,
            push: true,
            init: false
        });

        await runSyncCycle();
        console.log("\n✅ Sincronizzazione completata.");
    });
}

main().catch(console.error);
