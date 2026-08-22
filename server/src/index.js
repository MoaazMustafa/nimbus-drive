import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import express from 'express';
import config, { configProblems } from './config.js';
import { HttpError } from './util.js';
import { attachUser, requireAuth, requireBrowse, requireAdmin, authRouter } from './auth.js';
import { filesRouter } from './routes/files.js';
import { linksRouter, publicLinksRouter } from './routes/links.js';
import { adminRouter } from './routes/admin.js';
import { startWatcher, stopWatcher, eventsHandler } from './watcher.js';
import { pruneSessions, pruneActivity } from './db.js';
import { pruneThumbs } from './thumbs.js';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' })); // form-POST bulk zip

// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Same-origin guard for state-changing requests (cheap CSRF backstop on top of
// SameSite cookies). Allows requests whose Origin matches the host the page was
// actually served from — so reaching the app by its LAN IP still works — plus
// the configured base URL and localhost.
const allowedOrigins = new Set(
  [config.baseUrl, `http://localhost:${new URL(config.baseUrl).port || 3000}`, 'http://localhost:3000'].map((o) =>
    o.replace(/\/+$/, '')
  )
);
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // no Origin header → SameSite cookie is the real guard
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  // The web app proxies /api to this server, so req.headers.host is the internal
  // target (127.0.0.1:4400). The browser's real host arrives as X-Forwarded-Host.
  // Matching the Origin against either means reaching the app by its LAN IP or by
  // its public domain both work, without hard-coding every address.
  const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  if (originHost === req.headers.host || (fwd && originHost === fwd)) return true;
  return allowedOrigins.has(origin.replace(/\/+$/, ''));
}
app.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !originAllowed(req)) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: config.appName, problems: configProblems });
});

// Attach the user if signed in (never throws), then auth endpoints.
app.use('/api', attachUser, authRouter);

// Public links — reachable WITHOUT login (read-only). Mounted before the gate.
app.use('/api/public', publicLinksRouter);

// Everything below requires a signed-in, still-authorized user.
app.use('/api', (req, res, next) => requireAuth(req, res, next));

// Live updates
app.get('/api/events', requireBrowse, eventsHandler);

// File APIs
app.use('/api', filesRouter);

// Link management (create/list/delete)
app.use('/api', linksRouter);

// Admin
app.use('/api', requireAdmin, adminRouter);

// 404 for unknown API routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    if (!res.headersSent) res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[error]', err);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on the server' });
});

const server = app.listen(config.apiPort, config.apiHost, () => {
  console.log(`[${config.appName}] API listening on http://${config.apiHost}:${config.apiPort}`);
  console.log(`[${config.appName}] Storage root: ${config.storageRoot}`);
  if (configProblems.length) {
    for (const p of configProblems) console.warn(`[config] WARNING: ${p}`);
  }
});
server.requestTimeout = 0; // allow very large uploads/downloads
server.headersTimeout = 120000;

startWatcher();

/** Remove leftover upload temp files (aborted uploads used to orphan them forever). */
async function pruneTmp(maxAgeMs = 6 * 3600 * 1000) {
  const tmpDir = path.join(config.dataDir, 'tmp');
  try {
    const names = await fsp.readdir(tmpDir);
    const cutoff = Date.now() - maxAgeMs;
    for (const n of names) {
      try {
        const s = await fsp.stat(path.join(tmpDir, n));
        if (s.mtimeMs < cutoff) await fsp.rm(path.join(tmpDir, n), { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* tmp dir missing is fine */
  }
}
// On startup nothing is uploading yet, so clear any orphans from a previous run.
pruneTmp(0);

// Housekeeping every 6h
const housekeeping = setInterval(() => {
  try {
    pruneSessions();
  } catch { /* ignore */ }
  try {
    pruneActivity();
  } catch { /* ignore */ }
  pruneThumbs();
  pruneTmp();
}, 6 * 3600 * 1000);

async function shutdown() {
  console.log('\nShutting down…');
  clearInterval(housekeeping);
  await stopWatcher();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
