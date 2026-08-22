#!/usr/bin/env node
/**
 * End-to-end test of the desktop bootstrapper: a local mock of the GitHub API
 * serves a REAL tarball of this repo; the Bootstrap engine downloads it,
 * installs dependencies, builds the web app, activates the version, and the
 * Supervisor then boots the INSTALLED copy — the exact path a brand-new PC
 * takes after downloading Setup.exe.
 *
 *   node scripts/dev/bootstrap-test.mjs        (takes a few minutes: real npm install + next build)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Bootstrap } = require(path.join(ROOT, 'desktop', 'lib', 'bootstrap.js'));
const { GitHub, parseRepo } = require(path.join(ROOT, 'desktop', 'lib', 'github.js'));
const { ensureNode } = require(path.join(ROOT, 'desktop', 'lib', 'runtime.js'));
const { Supervisor } = require(path.join(ROOT, 'desktop', 'lib', 'supervisor.js'));

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
async function waitUntil(fn, ms, step = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

const MOCK_PORT = 4890;
const WEB_PORT = 4650;
const API_PORT = 4655;
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-home-'));

// ── build a GitHub-style release tarball of THIS repo ───────────────
console.log('\n— preparing mock release tarball (real repo contents)');
const tgz = path.join(home, 'release.tgz');
const tarStaging = path.join(home, 'tar-staging', 'nimbus-drive-mock1234');
await fsp.mkdir(tarStaging, { recursive: true });
for (const item of ['server', 'web', 'scripts', 'package.json', 'README.md']) {
  const src = path.join(ROOT, item);
  const dest = path.join(tarStaging, item);
  if (fs.existsSync(src)) {
    await fsp.cp(src, dest, {
      recursive: true,
      filter: (p) => !p.includes('node_modules') && !p.includes('.next') && !p.includes('.git') && !p.includes('desktop') && !p.includes('data') && !p.includes('storage') && !p.endsWith('.env'),
    });
  }
}
execSync(`tar czf ${JSON.stringify(tgz)} -C ${JSON.stringify(path.join(home, 'tar-staging'))} nimbus-drive-mock1234`, { stdio: 'ignore' });
check('tarball created', fs.existsSync(tgz) && fs.statSync(tgz).size > 10000);

// ── fake node runtime tarball (for ensureNode download test) ────────
const plat = process.platform === 'win32' ? 'win' : 'linux';
const fakeNodeDir = path.join(home, 'fakedist', `node-v22.15.0-${plat}-x64`);
const binSubDir = process.platform === 'win32' ? fakeNodeDir : path.join(fakeNodeDir, 'bin');
await fsp.mkdir(binSubDir, { recursive: true });
await fsp.mkdir(path.join(fakeNodeDir, 'node_modules', 'npm', 'bin'), { recursive: true });
await fsp.mkdir(path.join(fakeNodeDir, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
if (process.platform === 'win32') {
  await fsp.copyFile(process.execPath, path.join(binSubDir, 'node.exe'));
} else {
  await fsp.writeFile(path.join(binSubDir, 'node'), '#!/bin/sh\necho v22.15.0\n');
  await fsp.chmod(path.join(binSubDir, 'node'), 0o755);
}
await fsp.writeFile(path.join(fakeNodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// stub\n');
await fsp.writeFile(path.join(fakeNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// stub\n');
const fakeNodeTgz = path.join(home, 'fakedist', `node-v22.15.0-${plat}-x64.tar.gz`);
execSync(`tar czf ${JSON.stringify(fakeNodeTgz)} -C ${JSON.stringify(path.join(home, 'fakedist'))} node-v22.15.0-${plat}-x64`, { stdio: 'ignore' });

// ── mock GitHub API + download host ─────────────────────────────────
const mock = http.createServer((req, res) => {
  const url = req.url || '';
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url === '/repos/fam/nimbus-drive/releases/latest') {
    return json(200, {
      tag_name: 'v9.9.9',
      name: 'Family release',
      body: 'First public release',
      published_at: '2026-08-22T00:00:00Z',
      tarball_url: `http://127.0.0.1:${MOCK_PORT}/tarball/v9.9.9`,
    });
  }
  if (url === '/tarball/v9.9.9' || url === '/tarball/main') {
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': fs.statSync(tgz).size });
    return fs.createReadStream(tgz).pipe(res);
  }
  // repo with NO releases → branch fallback
  if (url === '/repos/solo/nightly/releases/latest') return json(404, { message: 'Not Found' });
  if (url === '/repos/solo/nightly') return json(200, { default_branch: 'main' });
  if (url === '/repos/solo/nightly/commits/main') {
    return json(200, { sha: 'abcdef1234567890', commit: { message: 'tip of main', committer: { date: '2026-08-21T00:00:00Z' } } });
  }
  if (url === '/repos/solo/nightly/tarball/main') {
    res.writeHead(200, { 'content-type': 'application/gzip' });
    return fs.createReadStream(tgz).pipe(res);
  }
  if (url.startsWith('/dist/v22.15.0/')) {
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': fs.statSync(fakeNodeTgz).size });
    return fs.createReadStream(fakeNodeTgz).pipe(res);
  }
  if (url === '/bad404') return json(404, { message: 'nope' });
  json(404, { message: `no route ${url}` });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

try {
  console.log('\n— repo parsing & GitHub client');
  check('parseRepo handles owner/repo', JSON.stringify(parseRepo('fam/nimbus-drive')) === '{"owner":"fam","repo":"nimbus-drive"}');
  check('parseRepo handles full URLs', JSON.stringify(parseRepo('https://github.com/fam/nimbus-drive.git')) === '{"owner":"fam","repo":"nimbus-drive"}');
  check('parseRepo rejects junk', parseRepo('not a repo!') === null);

  const gh = new GitHub({ apiBase: `http://127.0.0.1:${MOCK_PORT}` });
  const latest = await gh.latestVersion('fam', 'nimbus-drive');
  check('latest release found with notes + tarball', latest.kind === 'release' && latest.version === 'v9.9.9' && latest.notes.includes('First public'), JSON.stringify(latest));

  const nightly = await gh.latestVersion('solo', 'nightly');
  check('repo without releases falls back to branch tip', nightly.kind === 'branch' && nightly.version === 'main-abcdef1' && nightly.tarballUrl.includes('/tarball/main'), JSON.stringify(nightly));

  console.log('\n— portable Node runtime (download → extract → locate → verify)');
  const rt = await ensureNode({ homeDir: home, distBase: `http://127.0.0.1:${MOCK_PORT}/dist`, platform: process.platform, arch: 'x64' });
  check('runtime downloaded and node located', fs.existsSync(rt.nodeBin));
  check('npm-cli located inside runtime', rt.npmCli.endsWith('npm-cli.js') && fs.existsSync(rt.npmCli));
  const rt2 = await ensureNode({ homeDir: home, distBase: 'http://127.0.0.1:1/unreachable', platform: process.platform, arch: 'x64' });
  check('second ensureNode reuses the cached runtime (no network)', rt2.nodeBin === rt.nodeBin);

  console.log('\n— full install: download → extract → deps → build → activate (REAL npm + next build, be patient)');
  // real system runtime for the heavy work
  const realNpmCli = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : execSync('realpath "$(which npm)"').toString().trim().split(/\r?\n/)[0];
  const boot = new Bootstrap({ homeDir: home, runtime: { nodeBin: process.execPath, npmCli: realNpmCli } });
  boot.on('steplog', (l) => { globalThis.__lastLogLine = l.line; });
  const stepsSeen = [];
  boot.on('step', (s) => {
    stepsSeen.push(`${s.step}:${s.status}`);
    if (s.status !== 'running' || !stepsSeen.at(-2)?.startsWith(s.step)) console.log(`    [${s.step}] ${s.status} ${s.detail || ''}`);
  });

  // canonical config BEFORE install → the build must bake this API port
  await fsp.mkdir(path.join(home, 'config'), { recursive: true });
  await fsp.writeFile(
    path.join(home, 'config', '.env'),
    `APP_NAME=Nimbus Bootstrapped\nBASE_URL=http://localhost:${WEB_PORT}\nSTORAGE_ROOT=${path.join(home, 'familyfiles')}\nDATA_DIR=${path.join(home, 'data')}\nADMIN_EMAIL=owner@example.com\nGOOGLE_CLIENT_ID=x\nGOOGLE_CLIENT_SECRET=y\nAPI_PORT=${API_PORT}\n`
  );

  const installed = await boot.installVersion(latest);
  check('install completed and activated', installed.version === 'v9.9.9' && fs.existsSync(path.join(installed.path, 'web', '.next', 'BUILD_ID')));
  check('current.json points at the installed version', boot.current()?.path === installed.path);
  check('canonical .env was materialized into the version', fs.existsSync(path.join(installed.path, '.env')));
  check('the build baked OUR API port (env applied before build)', boot.bakedApiPort(installed.path) === API_PORT, String(boot.bakedApiPort(installed.path)));
  check('needsRebuild is false right after install', boot.needsRebuild() === false);
  check('install steps ran in order', ['download:ok', 'extract:ok', 'deps:ok', 'build:ok', 'activate:ok'].every((s) => stepsSeen.includes(s)), stepsSeen.join(','));

  console.log('\n— the INSTALLED version actually runs (supervisor boot)');
  const sup = new Supervisor({
    projectRoot: installed.path,
    getAppConfig: () => ({ tunnelEnabled: false, nodePath: process.execPath }),
    tuning: { backoff: [500, 1000], healthIntervalMs: 700, publicIntervalMs: 3600000 },
  });
  await sup.start();
  const up = await waitUntil(() => {
    const st = sup.state().services;
    return st.api?.status === 'online' && st.web?.status === 'online';
  }, 60000);
  check('installed drive reaches full online', up, JSON.stringify(sup.state().services));
  const viaProxy = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`).then((r) => r.json()).catch(() => null);
  check('proxy chain works on the installed copy', viaProxy?.ok === true && viaProxy.app === 'Nimbus Bootstrapped', JSON.stringify(viaProxy));
  await sup.stopAll();
  sup.close();

  console.log('\n— update awareness, rollback, and failure safety');
  check('same version → no update offered', boot.updateAvailable({ version: 'v9.9.9' }) === false);
  check('new version → update offered', boot.updateAvailable({ version: 'v9.9.10' }) === true);

  // manufacture a previous version to prove rollback repoints cleanly
  const prevDir = path.join(home, 'versions', 'v9.9.8');
  await fsp.mkdir(path.join(prevDir, 'server', 'src'), { recursive: true });
  await fsp.writeFile(path.join(prevDir, 'server', 'src', 'index.js'), '// old');
  await fsp.writeFile(path.join(prevDir, '.nimbus-version.json'), JSON.stringify({ version: 'v9.9.8', installedAt: 1 }));
  const rolled = await boot.rollback();
  check('rollback repoints to the previous version', rolled.version === 'v9.9.8' && boot.current().path === prevDir);
  check('rollback materialized the canonical .env', fs.existsSync(path.join(prevDir, '.env')));
  // roll forward again
  await fsp.writeFile(boot.currentFile, JSON.stringify({ version: 'v9.9.9', path: installed.path, activatedAt: Date.now() }));

  // needsRebuild flips when API_PORT changes
  const envFile = path.join(home, 'config', '.env');
  await fsp.writeFile(envFile, (await fsp.readFile(envFile, 'utf8')).replace(`API_PORT=${API_PORT}`, `API_PORT=${API_PORT + 1}`));
  await boot.materializeEnv(installed.path);
  check('API_PORT change is detected as needing a rebuild', boot.needsRebuild() === true);

  // failed install never harms the active version
  const before = boot.current()?.path;
  let threw = false;
  try {
    await boot.installVersion({ version: 'v0.0.0-broken', tarballUrl: `http://127.0.0.1:${MOCK_PORT}/bad404` });
  } catch {
    threw = true;
  }
  check('broken download fails loudly', threw);
  check('…and the active version is untouched', boot.current()?.path === before);
  check('…and no staging leftovers remain', !fs.readdirSync(path.join(home, 'versions')).some((n) => n.endsWith('.staging')));
} catch (err) {
  failed++;
  fails.push(`unexpected error: ${err.message}`);
  console.error('\nUnexpected error:', err);
} finally {
  mock.close();
  // keep this quiet on success; helps diagnose install failures
  if (failed > 0) console.error('last install log line:', globalThis.__lastLogLine || '(none)');
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n══ bootstrap: ${passed} passed, ${failed} failed ══`);
if (fails.length) {
  console.log('Failed:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
