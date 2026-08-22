#!/usr/bin/env node
/**
 * Tests the desktop app's supervision core against the REAL Nimbus server:
 * boots API + web under the Supervisor, verifies health, kills the API and
 * watches it auto-restart, checks port auto-healing and external detection,
 * then shuts everything down cleanly.
 *
 *   node scripts/dev/desktop-core-test.mjs
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Supervisor } = require(path.join(ROOT, 'desktop', 'lib', 'supervisor.js'));
const { parseEnvText, updateEnv, createEnv, validateEnvValues, redirectUri } = require(path.join(ROOT, 'desktop', 'lib', 'env.js'));
const { isPortFree, findFreePort } = require(path.join(ROOT, 'desktop', 'lib', 'ports.js'));
const { LogBuffer } = require(path.join(ROOT, 'desktop', 'lib', 'logbuf.js'));

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(step);
  }
  return false;
}

const WEB_PORT = 4570;
const API_PORT = 4400; // must match the port baked into the web build's /api proxy

// ── scratch env ─────────────────────────────────────────────────────
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-desktop-'));
const envPath = path.join(ROOT, '.env');
const envBackup = fs.existsSync(envPath) ? await fsp.readFile(envPath, 'utf8') : null;

console.log('\n— env manager');
{
  const parsed = parseEnvText('A=1\n# comment\nB="two"\n');
  check('parseEnvText reads values and strips quotes', parsed.A === '1' && parsed.B === 'two');

  createEnv(envPath, {
    APP_NAME: 'Nimbus DesktopTest',
    BASE_URL: `http://localhost:${WEB_PORT}`,
    STORAGE_ROOT: path.join(tmp, 'storage'),
    DATA_DIR: path.join(tmp, 'data'),
    ADMIN_EMAIL: 'owner@example.com',
    GOOGLE_CLIENT_ID: 'x',
    GOOGLE_CLIENT_SECRET: 'y',
    API_PORT: API_PORT,
  });
  const before = await fsp.readFile(envPath, 'utf8');
  updateEnv(envPath, { API_PORT: String(API_PORT) , APP_NAME: 'Nimbus DesktopTest' });
  const after = await fsp.readFile(envPath, 'utf8');
  check('updateEnv preserves comments and layout', after.includes('# Ports (change only if') && after.split('\n').length === before.split('\n').length);

  const problems = validateEnvValues({ ADMIN_EMAIL: 'bad', BASE_URL: 'nope', STORAGE_ROOT: path.join(tmp, 's2') }, { projectRoot: ROOT });
  check('validateEnvValues flags bad email/url/missing keys', problems.some((p) => p.field === 'ADMIN_EMAIL') && problems.some((p) => p.field === 'BASE_URL') && problems.some((p) => p.field === 'GOOGLE_CLIENT_ID'));
  check('validateEnvValues accepts a writable storage dir', !problems.some((p) => p.field === 'STORAGE_ROOT'));
  check('redirectUri derives the Google callback', redirectUri('https://drive.example.com/') === 'https://drive.example.com/api/auth/callback/google');
}

console.log('\n— ports & logs');
{
  const free = await findFreePort(49500);
  check('findFreePort returns a free port', Number.isInteger(free) && (await isPortFree(free)));
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(free, '127.0.0.1', r));
  check('isPortFree detects an occupied port', !(await isPortFree(free)));
  const next = await findFreePort(free);
  check('findFreePort skips the occupied port', next !== free);
  await new Promise((r) => blocker.close(r));

  const buf = new LogBuffer({ name: 't', capacity: 5 });
  for (let i = 0; i < 12; i++) buf.push(`line ${i}`);
  check('LogBuffer caps memory at capacity', buf.get({ limit: 100 }).length === 5 && buf.get({ limit: 100 })[4].line === 'line 11');
  check('LogBuffer filter works', buf.get({ filter: '11' }).length === 1);
}

// ── supervisor against the real server ──────────────────────────────
console.log('\n— supervisor boots the real Nimbus stack');
const sup = new Supervisor({
  projectRoot: ROOT,
  getAppConfig: () => ({ tunnelEnabled: false, tunnelName: 'nimbus', cloudflaredPath: 'cloudflared', nodePath: process.execPath }),
  tuning: { backoff: [400, 800, 1500], healthIntervalMs: 700, publicIntervalMs: 3600000 },
});
const failures = [];
sup.on('service-failed', (f) => failures.push(f));

try {
  await sup.start();
  check('supervisor accepted start (ports resolved)', sup.running === true && sup.apiPort === API_PORT && sup.webPort === WEB_PORT, JSON.stringify({ e: sup.startError, api: sup.apiPort, web: sup.webPort }));

  const apiUp = await waitUntil(async () => sup.state().services.api?.status === 'online', 20000);
  check('API reaches online (health check green)', apiUp, JSON.stringify(sup.state().services));
  const webUp = await waitUntil(async () => sup.state().services.web?.status === 'online', 40000);
  check('Web reaches online', webUp, JSON.stringify(sup.state().services));

  const viaProxy = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`).then((r) => r.json()).catch(() => null);
  check('web → API proxy chain works end-to-end', !!viaProxy?.ok && viaProxy.app === 'Nimbus DesktopTest', JSON.stringify(viaProxy));

  check('overall state is online', sup.state().overall === 'online');

  console.log('\n— crash recovery');
  const apiPid = sup.state().services.api.pid;
  process.kill(apiPid, 'SIGKILL');
  const wentDown = await waitUntil(async () => ['backoff', 'starting'].includes(sup.state().services.api.status), 8000, 100);
  check('API crash is detected', wentDown, sup.state().services.api.status);
  const cameBack = await waitUntil(async () => {
    const s = sup.state().services.api;
    return s.status === 'online' && s.pid && s.pid !== apiPid;
  }, 25000);
  check('API auto-restarts with a new pid and goes healthy again', cameBack, JSON.stringify(sup.state().services.api));

  console.log('\n— external instance detection');
  const det = await sup._detectNimbus(WEB_PORT, 'web');
  check('a running Nimbus is recognized on its port', !!det && det.kind === 'web', JSON.stringify(det));
  const notNimbus = await sup._detectNimbus(49999, 'web');
  check('an empty port is not mistaken for Nimbus', notNimbus === null);

  console.log('\n— clean shutdown');
  const pids = Object.values(sup.state().services).map((s) => s.pid).filter(Boolean);
  await sup.stopAll();
  await sleep(700);
  const alive = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  check('all child processes are gone after stopAll', alive.length === 0, `still alive: ${alive.join(',')}`);
  check('no crash-loop false alarms during the run', failures.length === 0, JSON.stringify(failures));

  console.log('\n— port auto-heal (fresh supervisor, web port occupied by a stranger)');
  const blocker2 = net.createServer((s) => s.destroy());
  await new Promise((r) => blocker2.listen(WEB_PORT, '127.0.0.1', r));
  const sup2 = new Supervisor({
    projectRoot: ROOT,
    getAppConfig: () => ({ tunnelEnabled: false, nodePath: process.execPath }),
    tuning: { backoff: [400, 800], healthIntervalMs: 700, publicIntervalMs: 3600000 },
  });
  const resolved = await sup2.resolvePorts();
  check('occupied web port auto-heals to the next free one', resolved.webPort && resolved.webPort !== WEB_PORT, JSON.stringify(resolved));
  const envNow = parseEnvText(await fsp.readFile(envPath, 'utf8'));
  check('BASE_URL follows the healed local port', envNow.BASE_URL === `http://localhost:${resolved.webPort}`, envNow.BASE_URL);
  // API port occupied by a stranger -> clear error, no silent half-broken start
  const blocker3 = net.createServer((s) => s.destroy());
  await new Promise((r) => blocker3.listen(API_PORT, '127.0.0.1', r));
  const resolvedApi = await sup2.resolvePorts();
  check('stranger on the API port yields an actionable error (no silent move)', !!resolvedApi.error && resolvedApi.error.includes('API_PORT'), JSON.stringify(resolvedApi));
  await new Promise((r) => blocker3.close(r));
  await new Promise((r) => blocker2.close(r));
  sup2.close();

  console.log('\n— crash-loop gives up cleanly (broken command)');
  const supBad = new Supervisor({
    projectRoot: ROOT,
    getAppConfig: () => ({ tunnelEnabled: true, tunnelName: 'nimbus', cloudflaredPath: '/definitely/not/cloudflared-xyz', nodePath: process.execPath }),
    tuning: { backoff: [200, 200], healthIntervalMs: 500, publicIntervalMs: 3600000 },
  });
  await supBad.start();
  const tunnelFailed = await waitUntil(async () => supBad.state().services.tunnel?.status === 'failed', 8000);
  check('missing cloudflared binary → tunnel marked failed with a message', tunnelFailed, JSON.stringify(supBad.state().services.tunnel));
  check('other services keep running despite the tunnel failure', ['starting', 'online'].includes(supBad.state().services.api.status));
  await supBad.stopAll();
  supBad.close();
} catch (err) {
  failed++;
  fails.push(`unexpected error: ${err.message}`);
  console.error('\nUnexpected error:', err);
  try { await sup.stopAll(); } catch { /* ignore */ }
} finally {
  sup.close();
  if (envBackup === null) await fsp.rm(envPath, { force: true });
  else await fsp.writeFile(envPath, envBackup);
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n══ desktop core: ${passed} passed, ${failed} failed ══`);
if (fails.length) {
  console.log('Failed:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
