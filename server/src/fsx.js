import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import mime from 'mime-types';
import config from './config.js';
import { httpError } from './util.js';

const ROOT = path.resolve(config.storageRoot);

/** Convert any client-supplied path to a safe relative POSIX path ('' = root). */
export function cleanRel(input) {
  let rel = String(input ?? '').replace(/\\/g, '/');
  if (rel.includes('\0')) throw httpError(400, 'Invalid path');
  rel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) return '';
  const parts = rel.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '.' || p === '..')) throw httpError(400, 'Invalid path');
  return parts.join('/');
}

/** Resolve a relative path to an absolute path guaranteed to live inside STORAGE_ROOT. */
export function resolveSafe(input) {
  const rel = cleanRel(input);
  const abs = rel ? path.resolve(ROOT, ...rel.split('/')) : ROOT;
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw httpError(400, 'Invalid path');
  return { abs, rel };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Validate a single file/folder name so it is legal on every OS we support. */
export function validateName(name) {
  const n = String(name ?? '').trim();
  if (!n || n === '.' || n === '..') throw httpError(400, 'Name is required');
  if (n.length > 200) throw httpError(400, 'Name is too long (max 200 characters)');
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) throw httpError(400, 'Name contains characters not allowed on some systems: < > : " / \\ | ? *');
  if (/[. ]$/.test(n)) throw httpError(400, 'Name cannot end with a space or a dot');
  if (WINDOWS_RESERVED.test(n.split('.')[0])) throw httpError(400, 'That name is reserved on Windows');
  return n;
}

export async function statOrNull(abs) {
  try {
    return await fsp.stat(abs);
  } catch {
    return null;
  }
}

export function kindOf(name, isDir) {
  if (isDir) return 'folder';
  const m = mime.lookup(name) || '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (
    m.startsWith('text/') ||
    ['application/json', 'application/javascript', 'application/xml', 'application/x-sh'].includes(m)
  )
    return 'text';
  if (
    ['application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/gzip', 'application/x-tar'].includes(m)
  )
    return 'archive';
  const ext = name.split('.').pop()?.toLowerCase();
  if (['doc', 'docx', 'odt'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'sheet';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return 'slides';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'rb', 'html', 'css', 'md', 'yml', 'yaml', 'toml', 'env', 'sql', 'txt', 'log'].includes(ext)) return 'text';
  return 'file';
}

/** List a directory inside the storage root. */
export async function listDir(rel) {
  const { abs, rel: cleaned } = resolveSafe(rel);
  const st = await statOrNull(abs);
  if (!st) throw httpError(404, 'Folder not found');
  if (!st.isDirectory()) throw httpError(400, 'Not a folder');
  const names = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of names) {
    // Never surface our own temp artifacts
    if (d.name === '.nimbus-tmp') continue;
    let s;
    try {
      s = await fsp.stat(path.join(abs, d.name));
    } catch {
      continue; // vanished mid-listing (or broken symlink)
    }
    const isDir = s.isDirectory();
    entries.push({
      name: d.name,
      path: cleaned ? `${cleaned}/${d.name}` : d.name,
      isDir,
      size: isDir ? null : s.size,
      mtime: s.mtimeMs,
      kind: kindOf(d.name, isDir),
    });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1));
  return { path: cleaned, entries };
}

/** Pick a non-colliding name in dir: "report.pdf" -> "report (1).pdf". */
export async function uniqueName(dirAbs, name) {
  let candidate = name;
  let i = 1;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  while (await statOrNull(path.join(dirAbs, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i += 1;
    if (i > 500) throw httpError(409, 'Too many name collisions');
  }
  return candidate;
}

/** Rename/move that survives crossing drives (EXDEV -> copy + delete). */
export async function moveResilient(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    const st = await fsp.stat(from);
    if (st.isDirectory()) {
      await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
      await fsp.rm(from, { recursive: true, force: true });
    } else {
      await pipeline(fs.createReadStream(from), fs.createWriteStream(to, { flags: 'wx' }));
      await fsp.rm(from, { force: true });
    }
  }
}

/** Recursive filename search with hard caps so huge trees cannot hang the server. */
export async function searchFiles(query, { maxResults = 200, maxVisited = 50000 } = {}) {
  const q = query.toLowerCase();
  const results = [];
  let visited = 0;
  async function walk(relDir) {
    if (results.length >= maxResults || visited >= maxVisited) return;
    let entries;
    try {
      entries = await fsp.readdir(relDir ? path.join(ROOT, ...relDir.split('/')) : ROOT, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (results.length >= maxResults || ++visited >= maxVisited) return;
      if (d.name === '.nimbus-tmp') continue;
      const relPath = relDir ? `${relDir}/${d.name}` : d.name;
      const isDir = d.isDirectory();
      if (d.name.toLowerCase().includes(q)) {
        let size = null;
        let mtime = 0;
        try {
          const s = await fsp.stat(path.join(ROOT, ...relPath.split('/')));
          size = isDir ? null : s.size;
          mtime = s.mtimeMs;
        } catch { /* ignore */ }
        results.push({ name: d.name, path: relPath, isDir, size, mtime, kind: kindOf(d.name, isDir) });
      }
      if (isDir) await walk(relPath);
    }
  }
  await walk('');
  return { results, truncated: visited >= maxVisited || results.length >= maxResults };
}

export { ROOT };
