'use strict';
/**
 * .env manager — reads and edits the project's .env while PRESERVING the
 * file's existing layout and comments (updates values in place, appends
 * missing keys at the end). The .env stays the single source of truth so
 * `npm start`, PM2, and the desktop app all see the same configuration.
 */
const fs = require('node:fs');
const path = require('node:path');

const KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

function parseEnvText(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = KEY_RE.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    values[m[1]] = v;
  }
  return values;
}

/** Make sure the folder holding the .env exists before any write. */
function ensureEnvDir(envPath) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
}

function readEnv(envPath) {
  if (!fs.existsSync(envPath)) return null;
  return parseEnvText(fs.readFileSync(envPath, 'utf8'));
}

/** Update keys in place, keeping comments/order; append keys the file lacks. */
function updateEnv(envPath, updates) {
  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.length ? original.split(/\r?\n/) : [];
  const remaining = { ...updates };
  const out = lines.map((line) => {
    const m = KEY_RE.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(remaining, m[1])) {
      const v = remaining[m[1]];
      delete remaining[m[1]];
      return `${m[1]}=${v}`;
    }
    return line;
  });
  const extras = Object.entries(remaining);
  if (extras.length) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    for (const [k, v] of extras) out.push(`${k}=${v}`);
  }
  ensureEnvDir(envPath);
  fs.writeFileSync(envPath, out.join(eol));
  return readEnv(envPath);
}

/** Create a fresh .env in the same format the setup wizard has always used. */
function createEnv(envPath, v) {
  const appName = v.APP_NAME || 'Nimbus Drive';
  const text = `# ─── ${appName} configuration ─────────────────────────────────
# This is the ONLY machine-specific file. Managed by the desktop app,
# but safe to edit by hand too.

APP_NAME=${appName}
BASE_URL=${v.BASE_URL || 'http://localhost:3000'}

# Where your files live on this machine's disk.
STORAGE_ROOT=${v.STORAGE_ROOT || './storage'}

# App data (database, thumbnails cache, trash) — safe to keep next to the app.
DATA_DIR=${v.DATA_DIR || './data'}

# The owner account. This Google account is always allowed and always admin.
ADMIN_EMAIL=${v.ADMIN_EMAIL || ''}

# Google OAuth (SETUP.md §2). Redirect URI must be: <BASE_URL>/api/auth/callback/google
GOOGLE_CLIENT_ID=${v.GOOGLE_CLIENT_ID || ''}
GOOGLE_CLIENT_SECRET=${v.GOOGLE_CLIENT_SECRET || ''}

# Ports (change only if something else already uses them)
API_PORT=${v.API_PORT || 4400}

# ── Tuning (sensible defaults) ──────────────────────────────────
SESSION_TTL_DAYS=${v.SESSION_TTL_DAYS || 30}
MAX_UPLOAD_MB=${v.MAX_UPLOAD_MB || 4096}
TRASH_ENABLED=${v.TRASH_ENABLED || 'true'}
WATCH_POLLING=${v.WATCH_POLLING || 'false'}
`;
  ensureEnvDir(envPath);
  fs.writeFileSync(envPath, text);
  return readEnv(envPath);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate a config object; returns a list of human-readable problems. */
function validateEnvValues(v, { projectRoot } = {}) {
  const problems = [];
  if (!v.ADMIN_EMAIL || !EMAIL_RE.test(String(v.ADMIN_EMAIL).trim())) {
    problems.push({ field: 'ADMIN_EMAIL', message: 'Enter the owner Google account email (e.g. you@gmail.com).' });
  }
  if (!v.GOOGLE_CLIENT_ID) {
    problems.push({ field: 'GOOGLE_CLIENT_ID', message: 'Google OAuth Client ID is required for sign-in (SETUP.md §2).' });
  }
  if (!v.GOOGLE_CLIENT_SECRET) {
    problems.push({ field: 'GOOGLE_CLIENT_SECRET', message: 'Google OAuth Client Secret is required for sign-in.' });
  }
  const base = String(v.BASE_URL || '').trim();
  if (!/^https?:\/\/[^\s/]+/i.test(base)) {
    problems.push({ field: 'BASE_URL', message: 'Base URL must start with http:// or https:// (e.g. https://drive.example.com).' });
  }
  const port = Number(v.API_PORT || 4400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push({ field: 'API_PORT', message: 'API port must be a number between 1 and 65535.' });
  }
  // Storage folder: must exist or be creatable, and be writable.
  const storage = String(v.STORAGE_ROOT || '').trim();
  if (!storage) {
    problems.push({ field: 'STORAGE_ROOT', message: 'Pick the folder where your files should live.' });
  } else {
    const abs = path.isAbsolute(storage) ? storage : path.resolve(projectRoot || process.cwd(), storage);
    try {
      fs.mkdirSync(abs, { recursive: true });
      const probe = path.join(abs, `.nimbus-write-test-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
    } catch (err) {
      problems.push({ field: 'STORAGE_ROOT', message: `Cannot write to "${storage}": ${err.code || err.message}` });
    }
  }
  return problems;
}

/** The Google redirect URI this configuration requires. */
function redirectUri(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/api/auth/callback/google`;
}

module.exports = { parseEnvText, readEnv, updateEnv, createEnv, validateEnvValues, redirectUri, ensureEnvDir };
