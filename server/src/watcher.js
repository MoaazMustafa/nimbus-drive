import path from 'node:path';
import chokidar from 'chokidar';
import config from './config.js';
import { canonicalPath } from './libraries.js';

/**
 * Watches the storage root so files pasted into the folder by hand
 * show up in the UI within a couple of seconds.
 *
 * Design note: the filesystem is always the source of truth — listings read the
 * disk directly — so if watching ever fails (exotic network drive, fd limits),
 * nothing breaks; the UI simply refreshes on navigation instead of live.
 */

const clients = new Set(); // Set<express.Response>
let pendingDirs = new Set();
let flushTimer = null;
let watcher = null;

/**
 * Turn an absolute path into the same relative path the API speaks — which
 * means finding WHICH attached folder it came from. Longest root first, so a
 * folder nested inside another attached folder is attributed correctly.
 */
const ROOTS_BY_DEPTH = [...config.libraries].sort((a, b) => b.root.length - a.root.length);
function toRel(absPath) {
  for (const lib of ROOTS_BY_DEPTH) {
    const rel = path.relative(lib.root, absPath).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!config.multiLibrary) return rel;
    return canonicalPath(lib, rel ? rel.split('/') : []);
  }
  return null;
}

function relParent(absPath) {
  const rel = toRel(absPath);
  if (rel === null) return null;
  if (!rel) return '';
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}

function queue(absPath, alsoSelf = false) {
  const parent = relParent(absPath);
  if (parent === null) return; // not inside any attached folder
  pendingDirs.add(parent);
  if (alsoSelf) {
    const rel = toRel(absPath);
    if (rel) pendingDirs.add(rel);
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      const dirs = [...pendingDirs];
      pendingDirs = new Set();
      flushTimer = null;
      broadcast({ type: 'fs', dirs });
    }, 400);
  }
}

function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(msg);
    } catch {
      clients.delete(res);
    }
  }
}

export function startWatcher() {
  try {
    const targets = config.libraries.filter((l) => l.available).map((l) => l.root);
    if (!targets.length) {
      console.warn('[watcher] no attached folder is available, live refresh disabled');
      return;
    }
    watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      usePolling: config.watchPolling,
      interval: 1500,
      awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 },
      ignored: (p) => p.includes('.nimbus-tmp'),
    });
    watcher
      .on('add', (p) => queue(p))
      .on('change', (p) => queue(p))
      .on('unlink', (p) => queue(p))
      .on('addDir', (p) => queue(p, true))
      .on('unlinkDir', (p) => queue(p, true))
      .on('error', (err) => console.warn('[watcher] non-fatal:', err.message));
    console.log(`[watcher] watching ${targets.join(', ')}${config.watchPolling ? ' (polling mode)' : ''}`);
  } catch (err) {
    console.warn('[watcher] could not start, live refresh disabled:', err.message);
  }
}

export async function stopWatcher() {
  if (watcher) await watcher.close().catch(() => {});
  for (const res of clients) {
    try {
      res.end();
    } catch { /* ignore */ }
  }
  clients.clear();
}

/** SSE endpoint handler. */
export function eventsHandler(req, res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* closed */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}
