#!/usr/bin/env node
/**
 * In-app Cloudflare tunnel setup: authorize, create, route, configure.
 *
 * These drive the real orchestration in desktop/lib/cftunnel.js against a
 * stand-in cloudflared, so the whole flow — including the browser login step
 * and its failure modes — is exercised without a Cloudflare account.
 *
 *   node scripts/dev/cftunnel-test.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cft = require(path.join(ROOT, 'desktop', 'lib', 'cftunnel.js'));

let passed = 0, failed = 0, skipped = 0; const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✘ ${name} ${extra}`); }
};
const skip = (name, why) => { skipped++; console.log(`  – ${name} (${why})`); };

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-cft-'));
const UUID = '451d9ecf-d503-4309-bd3a-0974ee86a5e3';

/**
 * A stand-in cloudflared. Behaviour is steered per-test through a JSON file so
 * the fake stays a faithful CLI and the tests stay readable.
 */
const FAKE = path.join(tmp, 'fake-cloudflared');
await fsp.writeFile(FAKE, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const cert = process.env.TUNNEL_ORIGIN_CERT || '';
const home = cert ? path.dirname(path.dirname(cert)) : '';
const stateFile = process.env.FAKE_STATE || '';
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const save = () => stateFile && fs.writeFileSync(stateFile, JSON.stringify(state));
const sub = argv[0] === 'tunnel' ? argv.slice(1) : argv;
const cmd = sub[0] === 'route' ? sub[1] : sub.find((a) => !a.startsWith('-'));
const rest = sub.filter((a) => !a.startsWith('-'));
state.tunnels = state.tunnels || [];

if (cmd === 'login') {
  console.log('Please open the following URL and log in with your Cloudflare account:');
  console.log('');
  console.log('https://dash.cloudflare.com/argotunnel?callback=https%3A%2F%2Flogin.cloudflareaccess.org%2FabC123');
  console.log('');
  console.log('Leave cloudflared running to download the cert automatically.');
  if (state.loginFails) { console.error('failed to write cert: user closed the browser'); process.exit(1); }
  setTimeout(() => {
    fs.mkdirSync(path.dirname(cert), { recursive: true });
    fs.writeFileSync(cert, '-----BEGIN ARGO TUNNEL TOKEN-----\\nfake\\n');
    console.log('You have successfully logged in.');
    process.exit(0);
  }, Number(state.loginDelayMs || 120));
  return;
}
if (cmd === 'list') {
  console.log('some preamble cloudflared likes to print');
  console.log(JSON.stringify(state.tunnels.map((t) => ({ id: t.id, name: t.name, connections: [] }))));
  process.exit(0);
}
if (cmd === 'create') {
  const name = rest[rest.length - 1];
  const credFlag = sub.indexOf('--credentials-file');
  const credFile = credFlag > -1 ? sub[credFlag + 1] : path.join(home, '.cloudflared', name + '.json');
  if (state.tunnels.some((t) => t.name === name)) { console.error('tunnel with name already exists'); process.exit(1); }
  const id = state.nextId || '${UUID}';
  state.tunnels.push({ id, name }); save();
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ AccountTag: 'acct', TunnelSecret: 'c2VjcmV0', TunnelID: id, TunnelName: name }));
  console.log(JSON.stringify({ id, name, credentials_file: credFile }));
  process.exit(0);
}
if (cmd === 'dns') {
  const host = rest[rest.length - 1];
  const force = sub.includes('--overwrite-dns') || sub.includes('-f');
  if (state.dnsTaken && state.dnsTaken === host && !force) {
    console.error('failed to add route: An A, AAAA, or CNAME record with that host already exists.');
    process.exit(1);
  }
  state.routed = host; state.routedForced = force; save();
  console.log('Added CNAME ' + host + ' which will route to this tunnel');
  process.exit(0);
}
if (cmd === 'delete') {
  const name = rest[rest.length - 1];
  state.tunnels = state.tunnels.filter((t) => t.name !== name); save();
  console.log('Deleted tunnel ' + name);
  process.exit(0);
}
console.error('Incorrect Usage: unknown command');
process.exit(1);
`, { mode: 0o755 });

let seq = 0;
async function fixture({ linked = false, tunnels = [], dnsTaken = null, loginFails = false, loginDelayMs = 120, localCreds = [] } = {}) {
  const home = path.join(tmp, `h${++seq}`);
  await fsp.mkdir(path.join(home, '.cloudflared'), { recursive: true });
  if (linked) await fsp.writeFile(path.join(home, '.cloudflared', 'cert.pem'), '-----BEGIN ARGO TUNNEL TOKEN-----\nx\n');
  for (const c of localCreds) {
    await fsp.writeFile(path.join(home, '.cloudflared', `${c.name || c.id}.json`),
      JSON.stringify({ AccountTag: 'acct', TunnelSecret: 'c2VjcmV0', TunnelID: c.id, TunnelName: c.name || null }));
  }
  const stateFile = path.join(home, 'state.json');
  await fsp.writeFile(stateFile, JSON.stringify({ tunnels, dnsTaken, loginFails, loginDelayMs }));
  process.env.FAKE_STATE = stateFile;
  return { home, stateFile, readState: async () => JSON.parse(await fsp.readFile(stateFile, 'utf8')) };
}

console.log('\n— what the machine has right now');
{
  const { home } = await fixture();
  const s = await cft.status({ bin: FAKE, home, baseUrl: 'https://cloud.example.com', tunnelName: 'nimbus' });
  check('reports cloudflared present', s.installed === true);
  check('reports the PC as not linked', s.linked === false);
  check('reports no config yet', s.hasConfig === false);
  check('is not ready', s.ready === false);
  check('derives the hostname from BASE_URL', s.hostname === 'cloud.example.com');
  check('does not call the API when unlinked', s.tunnels === null);

  const { home: home2 } = await fixture({ linked: true, tunnels: [{ id: UUID, name: 'nimbus' }] });
  const s2 = await cft.status({ bin: FAKE, home: home2, baseUrl: 'https://cloud.example.com', tunnelName: 'nimbus' });
  check('lists tunnels once linked', s2.tunnels?.length === 1, JSON.stringify(s2.tunnels));
  check('matches the configured tunnel name', s2.match?.id === UUID, JSON.stringify(s2.match));
  check('status never reports installed:false with a binary', s2.installed === true);
}

console.log('\n— authorizing the Cloudflare account from inside the app');
{
  const { home } = await fixture();
  const urls = [];
  const res = await cft.login({ bin: FAKE, home, onUrl: (u) => urls.push(u) });
  check('login completes', res.ok === true);
  check('the browser URL is handed to the caller', urls.length === 1, JSON.stringify(urls));
  check('...and it is the Cloudflare authorization page', /dash\.cloudflare\.com\/argotunnel/.test(urls[0] || ''), urls[0]);
  check('...with no trailing punctuation', !/[).,]$/.test(urls[0] || ''), urls[0]);
  check('cert.pem lands in the app-controlled home', fs.existsSync(path.join(home, '.cloudflared', 'cert.pem')));

  const { home: h2 } = await fixture({ loginFails: true });
  let err = null;
  try { await cft.login({ bin: FAKE, home: h2, onUrl: () => {} }); } catch (e) { err = e; }
  check('an abandoned browser step fails loudly', !!err);
  check('...and says what went wrong', /authorization did not finish/i.test(err?.message || ''), err?.message);

  // cancellation must not leave the app waiting five minutes
  const { home: h3 } = await fixture({ loginDelayMs: 30000 });
  const ac = new AbortController();
  const p = cft.login({ bin: FAKE, home: h3, onUrl: () => setTimeout(() => ac.abort(), 20), signal: ac.signal });
  let cancelled = null;
  try { await p; } catch (e) { cancelled = e; }
  check('login can be cancelled', /cancel/i.test(cancelled?.message || ''), cancelled?.message);
}

console.log('\n— creating and listing tunnels');
{
  const { home, readState } = await fixture({ linked: true });
  const list0 = await cft.listTunnels({ bin: FAKE, home });
  check('an account with no tunnels lists none', list0.length === 0);
  check('preamble before the JSON is tolerated', Array.isArray(list0));

  const made = await cft.createTunnel({ bin: FAKE, home, name: 'nimbus' });
  check('a tunnel is created', made.id === UUID, JSON.stringify(made));
  check('...and its credentials file is written where the app expects', fs.existsSync(made.credentialsFile));
  check('...and cloudflared now knows about it', (await readState()).tunnels.length === 1);

  const again = await cft.createTunnel({ bin: FAKE, home, name: 'nimbus' });
  check('creating an existing tunnel reuses it instead of failing', again.reused === true && again.id === UUID, JSON.stringify(again));

  check('a tunnel can be found by name', (await cft.findTunnelByName({ bin: FAKE, home, name: 'nimbus' }))?.id === UUID);
  check('an unknown name returns null', (await cft.findTunnelByName({ bin: FAKE, home, name: 'nope' })) === null);

  await cft.deleteTunnel({ bin: FAKE, home, name: 'nimbus' });
  check('a tunnel can be deleted', (await cft.listTunnels({ bin: FAKE, home })).length === 0);
}

console.log('\n— pointing the domain at the tunnel');
{
  const { home, readState } = await fixture({ linked: true, tunnels: [{ id: UUID, name: 'nimbus' }] });
  const r = await cft.routeDns({ bin: FAKE, home, name: 'nimbus', hostname: 'cloud.example.com' });
  check('a free hostname is routed', r.ok === true);
  check('...and cloudflared was asked for the right host', (await readState()).routed === 'cloud.example.com');

  const { home: h2 } = await fixture({ linked: true, tunnels: [{ id: UUID, name: 'nimbus' }], dnsTaken: 'cloud.example.com' });
  const taken = await cft.routeDns({ bin: FAKE, home: h2, name: 'nimbus', hostname: 'cloud.example.com' });
  check('an occupied hostname is reported, not thrown', taken.ok === false && taken.reason === 'exists', JSON.stringify(taken));

  const forced = await cft.routeDns({ bin: FAKE, home: h2, name: 'nimbus', hostname: 'cloud.example.com', overwrite: true });
  check('...and can be taken over on request', forced.ok === true);
}

console.log('\n— the whole setup, one button');
{
  const { home } = await fixture();
  const steps = [];
  const res = await cft.setup({
    bin: FAKE, home, name: 'nimbus', hostname: 'cloud.example.com', port: 3007,
    onStep: (e) => steps.push(e),
  });
  check('setup succeeds end to end', res.ok === true, JSON.stringify(res));
  check('...linking, tunnel, dns and config all run', ['link', 'tunnel', 'dns', 'config'].every((s) => steps.some((e) => e.step === s && e.status === 'ok')), JSON.stringify(steps.map((s) => `${s.step}:${s.status}`)));
  check('...the browser step is surfaced as an action with a URL', steps.some((e) => e.status === 'action' && /dash\.cloudflare\.com/.test(e.url || '')), JSON.stringify(steps.filter((s) => s.status === 'action')));
  const text = await fsp.readFile(res.configPath, 'utf8');
  check('...the config names the created tunnel', text.includes(UUID), text);
  check('...routes the requested hostname', text.includes('hostname: cloud.example.com'), text);
  check('...and targets the live web port', text.includes('service: http://localhost:3007'), text);
  check('...cert.pem exists afterwards', fs.existsSync(path.join(home, '.cloudflared', 'cert.pem')));

  // second run on an already-configured machine must be a no-op-ish success
  const steps2 = [];
  const res2 = await cft.setup({ bin: FAKE, home, name: 'nimbus', hostname: 'cloud.example.com', port: 3007, onStep: (e) => steps2.push(e) });
  check('re-running setup is safe', res2.ok === true);
  check('...and skips the browser step when already linked', steps2.some((e) => e.step === 'link' && e.status === 'ok' && /already linked/i.test(e.detail || '')), JSON.stringify(steps2[0]));
  check('...and reuses the existing tunnel', steps2.some((e) => e.step === 'tunnel' && /existing tunnel/i.test(e.detail || '')), JSON.stringify(steps2.find((s) => s.step === 'tunnel')));
}

console.log('\n— setup refuses clearly rather than half-finishing');
{
  const { home } = await fixture({ linked: true, tunnels: [{ id: UUID, name: 'nimbus' }], localCreds: [{ id: UUID, name: 'nimbus' }], dnsTaken: 'cloud.example.com' });
  let err = null;
  const steps = [];
  try {
    await cft.setup({ bin: FAKE, home, name: 'nimbus', hostname: 'cloud.example.com', port: 3000, onStep: (e) => steps.push(e) });
  } catch (e) { err = e; }
  check('a hostname already in use stops the run', !!err, JSON.stringify(steps.map((s) => `${s.step}:${s.status}`)));
  check('...and is flagged as fixable by overwriting', err?.needsOverwrite === true);
  check('...and no config is written from a half-finished run', !fs.existsSync(path.join(home, '.cloudflared', 'config.yml')));

  const ok = await cft.setup({ bin: FAKE, home, name: 'nimbus', hostname: 'cloud.example.com', port: 3000, overwriteDns: true, onStep: () => {} });
  check('re-running with overwrite completes', ok.ok === true && ok.dns === 'overwritten', JSON.stringify(ok));

  const { home: h2 } = await fixture({ linked: true });
  let err2 = null;
  try { await cft.setup({ bin: FAKE, home: h2, name: 'nimbus', hostname: '', port: 3000 }); } catch (e) { err2 = e; }
  check('a missing domain is refused with guidance', /BASE_URL/.test(err2?.message || ''), err2?.message);

  let err3 = null;
  try { await cft.setup({ bin: null, home: h2, name: 'nimbus', hostname: 'cloud.example.com' }); } catch (e) { err3 = e; }
  check('a missing cloudflared is refused first', /not installed/i.test(err3?.message || ''), err3?.message);
}

console.log('\n— a tunnel that exists in the account but not on this PC');
{
  // exactly what happens after reinstalling Windows, moving machines, or
  // deleting ~/.cloudflared: Cloudflare still lists the tunnel, but the secret
  // it issued at creation is gone and cannot be fetched again.
  const { home } = await fixture({ linked: true, tunnels: [{ id: UUID, name: 'nimbus' }] });
  let err = null;
  const steps = [];
  try {
    await cft.setup({ bin: FAKE, home, name: 'nimbus', hostname: 'cloud.example.com', port: 3000, onStep: (e) => steps.push(e) });
  } catch (e) { err = e; }
  check('the missing credentials file is caught before anything is written', !!err);
  check('...and explained rather than blamed on the config', /credentials file is not on this PC/i.test(err?.message || ''), err?.message);
  check('...and flagged as fixable by recreating', err?.needsRecreate === true);
  check('...offering the other two ways out', /another name|tunnel token/i.test(err?.message || ''), err?.message);
  check('...leaving no half-written config behind', !fs.existsSync(path.join(home, '.cloudflared', 'config.yml')));

  const steps2 = [];
  const ok = await cft.setup({ bin: FAKE, home, name: 'nimbus', hostname: 'cloud.example.com', port: 3000, recreate: true, onStep: (e) => steps2.push(e) });
  check('recreating completes the setup', ok.ok === true, JSON.stringify(ok));
  check('...and this PC now owns the credentials', fs.existsSync(path.join(home, '.cloudflared', 'nimbus.json')));
  check('...and the step log says it was replaced', steps2.some((e) => /Replacing the tunnel/i.test(e.detail || '')), JSON.stringify(steps2.map((s) => s.detail)));
  const text = await fsp.readFile(ok.configPath, 'utf8');
  check('...and the config points at the credentials that exist', text.includes(path.join(home, '.cloudflared', 'nimbus.json')), text);
}

console.log('\n— cloudflared failures reach the user intact');
{
  const { home } = await fixture({ linked: true });
  let err = null;
  try { await cft.run(path.join(tmp, 'no-such-binary'), ['tunnel', 'list'], { home }); } catch (e) { err = e; }
  check('a missing binary is reported, not swallowed', /Could not run cloudflared/i.test(err?.message || ''), err?.message);

  const slow = await fsp.writeFile(path.join(tmp, 'slow'), '#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n', { mode: 0o755 });
  let t = null;
  try { await cft.run(path.join(tmp, 'slow'), ['tunnel', 'list'], { home, timeoutMs: 250 }); } catch (e) { t = e; }
  check('a hung cloudflared times out instead of hanging the app', /timed out/i.test(t?.message || ''), t?.message);
}

console.log('\n— the setup is actually reachable from the UI');
{
  // the tunnel-mode bug taught this lesson: a feature that is not wired end to
  // end is invisible, and unit tests on the module will not notice.
  const mainSrc = await fsp.readFile(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  for (const ch of ['tunnel:status', 'tunnel:install', 'tunnel:setup', 'tunnel:cancel', 'tunnel:delete']) {
    check(`main.js handles ${ch}`, mainSrc.includes(`ipcMain.handle('${ch}'`), '');
  }
  check('main.js opens the authorization URL itself', /shell\.openExternal\(evt\.url\)/.test(mainSrc));
  check('a finished setup switches the app to named mode', /appConfig\.tunnelMode = 'named'/.test(mainSrc));

  const preloadSrc = await fsp.readFile(path.join(ROOT, 'desktop', 'preload.js'), 'utf8');
  for (const m of ['tunnelStatus', 'tunnelInstall', 'tunnelSetup', 'tunnelCancel', 'tunnelDelete', 'onTunnelStep']) {
    check(`preload exposes ${m}`, new RegExp(`\\b${m}:`).test(preloadSrc), '');
  }

  const html = await fsp.readFile(path.join(ROOT, 'desktop', 'ui', 'index.html'), 'utf8');
  for (const id of ['tunnel-setup', 'tunnel-state', 'tunnel-steps', 'tunnel-hint', 'btn-tunnel-setup', 'btn-tunnel-install', 'btn-tunnel-cancel', 'btn-tunnel-refresh', 'f-tunnelOverwriteDns', 'f-tunnelRecreate']) {
    check(`the panel has #${id}`, html.includes(`id="${id}"`), '');
  }
}

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n══ tunnel setup: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
