import express from 'express';
import config, { configProblems } from './config.js';
import { HttpError } from './util.js';
import { attachUser, requireAuth, requireBrowse, requireAdmin, authRouter } from './auth.js';
import { filesRouter } from './routes/files.js';
import { sharesRouter } from './routes/shares.js';
import { adminRouter } from './routes/admin.js';
import { startWatcher, stopWatcher, eventsHandler } from './watcher.js';
import { pruneSessions } from './db.js';
import { pruneThumbs } from './thumbs.js';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Same-origin guard for state-changing requests (cheap CSRF backstop on top of SameSite cookies)
const allowedOrigins = new Set(
  [config.baseUrl, `http://localhost:${new URL(config.baseUrl).port || 3000}`, 'http://localhost:3000'].map((o) =>
    o.replace(/\/+$/, '')
  )
);
app.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin.replace(/\/+$/, ''))) {
      return res.status(403).json({ error: 'Cross-origin request blocked' });
    }
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: config.appName, problems: configProblems });
});

app.use('/api', attachUser, authRouter);

// Everything below requires a signed-in, still-authorized user
app.use('/api', (req, res, next) => requireAuth(req, res, next));

// Live updates (only useful to people who can browse; harmless otherwise)
app.get('/api/events', requireBrowse, eventsHandler);

// File APIs — browse permission (owner/admins, or everyone when visibility is 'everyone')
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/fs/')) return requireBrowse(req, res, next);
  next();
});
app.use('/api', filesRouter);

// Shares — reachable by any authorized user (per-share access is checked inside)
app.use('/api', sharesRouter);

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

// Housekeeping every 6h
const housekeeping = setInterval(() => {
  try {
    pruneSessions();
  } catch { /* ignore */ }
  pruneThumbs();
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
