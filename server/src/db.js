import path from 'node:path';
import Database from 'better-sqlite3';
import config from './config.js';
import { escapeLike } from './util.js';

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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Public links: anyone with the token can open the item, no login required (read-only).
CREATE TABLE IF NOT EXISTS links (
  token TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  is_dir INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_links_path ON links(rel_path);
CREATE INDEX IF NOT EXISTS idx_links_creator ON links(created_by);

-- Trash: metadata for items moved to DATA_DIR/trash so they can be restored.
CREATE TABLE IF NOT EXISTS trash (
  id TEXT PRIMARY KEY,          -- on-disk filename inside data/trash
  orig_path TEXT NOT NULL,      -- original rel path it came from
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL,
  size INTEGER,
  deleted_by TEXT,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trash_deleted_at ON trash(deleted_at);

-- Activity log: who did what, when (for the admin audit view).
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  email TEXT,
  action TEXT NOT NULL,
  path TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);
CREATE INDEX IF NOT EXISTS idx_activity_email ON activity(email);
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

// ---------- roles ----------
// Model: everyone on the allowlist (and the owner) has FULL access to the drive.
// Admins additionally manage the allowlist and see the activity log.
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
// Kept for API shape; every authorized user can browse the whole drive now.
export function canBrowseEmail(email) {
  return isAuthorizedEmail(email);
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

// ---------- public links ----------
export const insertLink = db.prepare(`
INSERT INTO links (token, rel_path, is_dir, created_by, created_at, expires_at)
VALUES (@token, @rel_path, @is_dir, @created_by, @created_at, @expires_at)
`);
export const getLink = (token) => {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM links WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at && s.expires_at < Date.now()) return null;
  return s;
};
export const deleteLink = (token) => db.prepare('DELETE FROM links WHERE token = ?').run(token);
export const linksForPath = (relPath) => db.prepare('SELECT * FROM links WHERE rel_path = ?').all(relPath);
export const linksByCreator = (email) =>
  db.prepare('SELECT * FROM links WHERE created_by = ? ORDER BY created_at DESC').all(email);
export const allLinks = () => db.prepare('SELECT * FROM links ORDER BY created_at DESC').all();

/** Keep link paths in sync when files are renamed/moved inside the app. */
export function retargetLinks(oldRel, newRel) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE links SET rel_path = ? WHERE rel_path = ?').run(newRel, oldRel);
    const prefix = oldRel + '/';
    const rows = db
      .prepare("SELECT token, rel_path FROM links WHERE rel_path LIKE ? ESCAPE '\\'")
      .all(escapeLike(prefix) + '%');
    for (const r of rows) {
      db.prepare('UPDATE links SET rel_path = ? WHERE token = ?').run(
        newRel + '/' + r.rel_path.slice(prefix.length),
        r.token
      );
    }
  });
  tx();
}
/** Remove links pointing at a deleted path (and anything under it). */
export function dropLinksUnder(rel) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM links WHERE rel_path = ?').run(rel);
    db.prepare("DELETE FROM links WHERE rel_path LIKE ? ESCAPE '\\'").run(escapeLike(rel + '/') + '%');
  });
  tx();
}

// ---------- trash ----------
export const addTrash = db.prepare(`
INSERT INTO trash (id, orig_path, name, is_dir, size, deleted_by, deleted_at)
VALUES (@id, @orig_path, @name, @is_dir, @size, @deleted_by, @deleted_at)
`);
export const listTrash = () => db.prepare('SELECT * FROM trash ORDER BY deleted_at DESC').all();
export const getTrash = (id) => db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
export const removeTrash = (id) => db.prepare('DELETE FROM trash WHERE id = ?').run(id);
export const clearTrash = () => db.prepare('DELETE FROM trash').run();

// ---------- activity ----------
const insertActivity = db.prepare(
  'INSERT INTO activity (ts, email, action, path, detail, ip) VALUES (?, ?, ?, ?, ?, ?)'
);
export function logActivity({ email = null, action, path = null, detail = null, ip = null }) {
  try {
    insertActivity.run(Date.now(), email, action, path, detail, ip);
  } catch {
    /* logging must never break a request */
  }
}
export function listActivity({ limit = 100, offset = 0, email = null, action = null } = {}) {
  const where = [];
  const args = [];
  if (email) {
    where.push('email = ?');
    args.push(email);
  }
  if (action) {
    where.push('action = ?');
    args.push(action);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM activity ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(Math.max(1, limit), 500), Math.max(0, offset));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM activity ${clause}`).get(...args).n;
  return { rows, total };
}
export const pruneActivity = (keep = 20000) =>
  db
    .prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY ts DESC LIMIT ?)')
    .run(keep);

export default db;
