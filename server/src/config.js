import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { buildLibraries } from './libraries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root = two levels up from server/src
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Single .env at the project root is the only machine-specific file.
dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function abs(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(PROJECT_ROOT, p);
}

const config = {
  appName: process.env.APP_NAME || 'Nimbus Drive',
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  apiPort: num(process.env.API_PORT, 4400),
  apiHost: process.env.API_HOST || '127.0.0.1',
  storageRoot: abs(process.env.STORAGE_ROOT) || path.join(PROJECT_ROOT, 'storage'),
  storageRootName: (process.env.STORAGE_ROOT_NAME || 'My Drive').trim() || 'My Drive',
  storageRoots: process.env.STORAGE_ROOTS || '',
  dataDir: abs(process.env.DATA_DIR) || path.join(PROJECT_ROOT, 'data'),
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authorizeUrl: process.env.GOOGLE_AUTHORIZE_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    userinfoUrl: process.env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
  },
  sessionTtlDays: num(process.env.SESSION_TTL_DAYS, 30),
  maxUploadMb: num(process.env.MAX_UPLOAD_MB, 4096),
  watchPolling: bool(process.env.WATCH_POLLING, false),
  trashEnabled: bool(process.env.TRASH_ENABLED, true),
  isHttps: (process.env.BASE_URL || '').startsWith('https://'),
};

const problems = [];
if (!config.adminEmail) problems.push('ADMIN_EMAIL is not set — nobody would be able to log in.');
if (!config.google.clientId || !config.google.clientSecret) {
  problems.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set — Google sign-in cannot work. See SETUP.md.');
}
// Attached folders. The first is always STORAGE_ROOT, so a drive that has only
// ever had one folder keeps behaving exactly as it did.
const built = buildLibraries({
  defaultRoot: config.storageRoot,
  defaultName: config.storageRootName,
  spec: config.storageRoots,
  resolve: (p) => abs(p),
});
config.libraries = built.libraries.map((l) => ({ ...l, available: fs.existsSync(l.root) }));
config.multiLibrary = config.libraries.length > 1;
for (const p of built.problems) problems.push(p);
for (const lib of config.libraries) {
  // A removable drive that is not plugged in is not a crash — it is a folder
  // that is temporarily away, and the UI says so.
  if (!lib.available) problems.push(`Attached folder "${lib.name}" is not available right now (${lib.root}).`);
}

export const configProblems = problems;

// Make sure the writable directories exist up front.
for (const dir of [
  config.storageRoot,
  config.dataDir,
  path.join(config.dataDir, 'tmp'),
  path.join(config.dataDir, 'thumbs'),
  path.join(config.dataDir, 'trash'),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

export default config;
