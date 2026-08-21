import path from 'node:path';
import chokidar from 'chokidar';
import config from './config.js';
import { ROOT } from './fsx.js';

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

function relParent(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return '';
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}

function queue(absPath, alsoSelf = false) {
  pendingDirs.add(relParent(absPath));
  if (alsoSelf) {
    const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
    if (rel && !rel.startsWith('..')) pendingDirs.add(rel);
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
    watcher = chokidar.watch(ROOT, {
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
    console.log(`[watcher] watching ${ROOT}${config.watchPolling ? ' (polling mode)' : ''}`);
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
