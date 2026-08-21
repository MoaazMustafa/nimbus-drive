import path from 'node:path';
import Database from 'better-sqlite3';
import config from './config.js';

const db = new Database(path.join(config.dataDir, 'nimbus.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT,
  picture TEXT,
  first_login_at INTEGER,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS allowlist (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user',
  added_by TEXT,
  added_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER,
  expires_at INTEGER,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  is_dir INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('workspace','restricted')),
  created_by TEXT NOT NULL,
  created_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shares_path ON shares(rel_path);
CREATE TABLE IF NOT EXISTS share_members (
  token TEXT NOT NULL REFERENCES shares(token) ON DELETE CASCADE,
  email TEXT NOT NULL,
  PRIMARY KEY (token, email)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------- settings ----------
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
export const getSetting = (key, dflt = null) => {
  const row = getSettingStmt.get(key);
  return row ? row.value : dflt;
};
export const setSetting = (key, value) => setSettingStmt.run(key, String(value));

// visibility: 'admin_only' (guests only see what is shared with them) | 'everyone' (all authorized users browse the whole drive)
export const getVisibility = () => getSetting('visibility', 'admin_only');

// ---------- roles ----------
const allowRow = db.prepare('SELECT * FROM allowlist WHERE email = ?');
export function isAdminEmail(email) {
  if (!email) return false;
  if (email === config.adminEmail) return true;
  const row = allowRow.get(email);
  return !!row && row.role === 'admin';
}
export function isAuthorizedEmail(email) {
  if (!email) return false;
  if (email === config.adminEmail) return true;
  return !!allowRow.get(email);
}
export function canBrowseEmail(email) {
  if (isAdminEmail(email)) return true;
  return isAuthorizedEmail(email) && getVisibility() === 'everyone';
}

// ---------- users ----------
const upsertUserStmt = db.prepare(`
INSERT INTO users (email, name, picture, first_login_at, last_login_at)
VALUES (@email, @name, @picture, @now, @now)
ON CONFLICT(email) DO UPDATE SET name = @name, picture = @picture, last_login_at = @now
`);
export const upsertUser = (u) => upsertUserStmt.run({ ...u, now: Date.now() });
export const listUsers = () => db.prepare('SELECT * FROM users ORDER BY last_login_at DESC').all();

// ---------- sessions ----------
const insertSession = db.prepare(
  'INSERT INTO sessions (id, email, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
);
const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
const delSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
export function createSession(id, email, ttlMs, userAgent) {
  const t = Date.now();
  insertSession.run(id, email, t, t + ttlMs, (userAgent || '').slice(0, 300));
}
export function getSession(id) {
  if (!id) return null;
  const s = getSessionStmt.get(id);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    delSessionStmt.run(id);
    return null;
  }
  return s;
}
export const deleteSession = (id) => delSessionStmt.run(id);
export const pruneSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// ---------- allowlist ----------
export const listAllowlist = () => db.prepare('SELECT * FROM allowlist ORDER BY added_at ASC').all();
export const addAllowlist = (email, role, addedBy) =>
  db
    .prepare(
      'INSERT INTO allowlist (email, role, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET role = excluded.role'
    )
    .run(email, role, addedBy, Date.now());
export function removeAllowlist(email) {
  db.prepare('DELETE FROM allowlist WHERE email = ?').run(email);
  db.prepare('DELETE FROM sessions WHERE email = ?').run(email); // revoke access immediately
}

// ---------- shares ----------
export const insertShare = db.prepare(`
INSERT INTO shares (token, rel_path, is_dir, mode, created_by, created_at, expires_at)
VALUES (@token, @rel_path, @is_dir, @mode, @created_by, @created_at, @expires_at)
`);
export const getShare = (token) => {
  const s = db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at && s.expires_at < Date.now()) return null;
  return s;
};
export const shareMembers = (token) =>
  db.prepare('SELECT email FROM share_members WHERE token = ?').all(token).map((r) => r.email);
export const addShareMember = (token, email) =>
  db.prepare('INSERT OR IGNORE INTO share_members (token, email) VALUES (?, ?)').run(token, email);
export const clearShareMembers = (token) => db.prepare('DELETE FROM share_members WHERE token = ?').run(token);
export const deleteShare = (token) => db.prepare('DELETE FROM shares WHERE token = ?').run(token);
export const sharesForPath = (relPath) => db.prepare('SELECT * FROM shares WHERE rel_path = ?').all(relPath);
export const sharesByCreator = (email) =>
  db.prepare('SELECT * FROM shares WHERE created_by = ? ORDER BY created_at DESC').all(email);
export const allShares = () => db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all();
export const sharesVisibleTo = (email) =>
  db
    .prepare(
      `SELECT DISTINCT s.* FROM shares s
       LEFT JOIN share_members m ON m.token = s.token
       WHERE (s.mode = 'workspace' OR m.email = ?) AND s.created_by != ?
         AND (s.expires_at IS NULL OR s.expires_at > ?)
       ORDER BY s.created_at DESC`
    )
    .all(email, email, Date.now());

/** Keep share paths in sync when files are renamed/moved inside the app. */
export function retargetShares(oldRel, newRel) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE shares SET rel_path = ? WHERE rel_path = ?').run(newRel, oldRel);
    const prefix = oldRel + '/';
    const rows = db.prepare('SELECT token, rel_path FROM shares WHERE rel_path LIKE ?').all(prefix + '%');
    for (const r of rows) {
      db.prepare('UPDATE shares SET rel_path = ? WHERE token = ?').run(newRel + '/' + r.rel_path.slice(prefix.length), r.token);
    }
  });
  tx();
}
/** Remove shares pointing at a deleted path (and anything under it). */
export function dropSharesUnder(rel) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM shares WHERE rel_path = ?').run(rel);
    db.prepare("DELETE FROM shares WHERE rel_path LIKE ?").run(rel + '/%');
  });
  tx();
}

export default db;
