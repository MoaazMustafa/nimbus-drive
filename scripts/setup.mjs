#!/usr/bin/env node
/**
 * Interactive setup — creates/updates the .env file at the project root.
 * Works the same on Windows, macOS and Linux. Run with:  npm run setup
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function parseEnv(txt) {
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const existing = fs.existsSync(ENV_PATH) ? parseEnv(fs.readFileSync(ENV_PATH, 'utf8')) : {};

async function ask(label, key, dflt, { secret = false, required = false } = {}) {
  const current = existing[key] ?? dflt ?? '';
  const shown = secret && current ? `${String(current).slice(0, 4)}…` : current;
  while (true) {
    const answer = (await rl.question(`${label}${shown ? ` [${shown}]` : ''}: `)).trim();
    const value = answer || current;
    if (value || !required) return value;
    console.log('  → this one is required.');
  }
}

console.log('\n☁  Nimbus Drive setup — answers are saved to .env at the project root.');
console.log('   Press Enter to keep the value shown in [brackets].\n');

const appName = await ask('App name', 'APP_NAME', 'Nimbus Drive');
const storage = await ask('Storage folder (files live here; absolute path recommended, e.g. D:\\CloudDrive or /srv/drive)', 'STORAGE_ROOT', path.join(ROOT, 'storage'));
const admin = await ask('Owner Google email (always admin)', 'ADMIN_EMAIL', '', { required: true });
console.log('\n   Google OAuth credentials — see SETUP.md §2 for how to create them (free, ~5 minutes).');
const gid = await ask('Google OAuth Client ID', 'GOOGLE_CLIENT_ID', '', { required: true });
const gsecret = await ask('Google OAuth Client Secret', 'GOOGLE_CLIENT_SECRET', '', { secret: true, required: true });
console.log('\n   The public URL people will use. Keep the default for local use,');
console.log('   or set your Cloudflare Tunnel domain, e.g. https://drive.example.com');
const base = await ask('Base URL', 'BASE_URL', 'http://localhost:3000');

const env = `# ─── ${appName} configuration ─────────────────────────────────────
# This is the ONLY machine-specific file. To move to a new machine:
# copy the project + your storage folder, run "npm run install:all",
# adjust the paths below, done.

APP_NAME=${appName}
BASE_URL=${base}

# Where your files live on this machine's disk.
STORAGE_ROOT=${storage}

# App data (database, thumbnails cache, trash) — safe to keep next to the app.
DATA_DIR=${existing.DATA_DIR ?? path.join(ROOT, 'data')}

# The owner account. This Google account is always allowed and always admin.
ADMIN_EMAIL=${admin}

# Google OAuth (SETUP.md §2). Redirect URI must be: <BASE_URL>/api/auth/callback/google
GOOGLE_CLIENT_ID=${gid}
GOOGLE_CLIENT_SECRET=${gsecret}

# Ports (change only if something else already uses them)
API_PORT=${existing.API_PORT ?? 4400}

# ── Tuning (sensible defaults) ──────────────────────────────────────
SESSION_TTL_DAYS=${existing.SESSION_TTL_DAYS ?? 30}
MAX_UPLOAD_MB=${existing.MAX_UPLOAD_MB ?? 4096}
# Deleted items go to DATA_DIR/trash instead of being destroyed
TRASH_ENABLED=${existing.TRASH_ENABLED ?? 'true'}
# Set to true if the storage folder is on a network drive and changes
# made outside the app don't show up in the UI
WATCH_POLLING=${existing.WATCH_POLLING ?? 'false'}
`;

if (fs.existsSync(ENV_PATH)) {
  fs.copyFileSync(ENV_PATH, ENV_PATH + '.bak');
  console.log('\n   (previous .env backed up to .env.bak)');
}
fs.writeFileSync(ENV_PATH, env);
fs.mkdirSync(path.resolve(ROOT, storage), { recursive: true });

console.log(`\n✔ Saved .env`);
console.log(`✔ Storage folder ready: ${storage}`);
console.log(`\nNext steps:`);
console.log(`  1. In Google Cloud Console, make sure this redirect URI is added:`);
console.log(`       ${base.replace(/\/+$/, '')}/api/auth/callback/google`);
console.log(`  2. Build the web app once:   npm run build`);
console.log(`  3. Start everything:         npm start`);
console.log(`  4. Open ${base} and sign in with ${admin}\n`);

rl.close();
