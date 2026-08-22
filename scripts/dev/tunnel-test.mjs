#!/usr/bin/env node
/**
 * Cloudflare tunnel launch tests.
 *
 * The regression that motivated this: the app built
 *     cloudflared tunnel run --config <file> <name>
 * but --config is a *tunnel command* option, so cloudflared exited instantly
 * with "Incorrect Usage: flag provided but not defined: -config" and the
 * supervisor crash-looped. Correct form:
 *     cloudflared tunnel --config <file> run <name>
 *
 * If a real cloudflared binary is available (CLOUDFLARED_BIN, or on PATH) the
 * built command is handed to it for real to prove it parses.
 *
 *   node scripts/dev/tunnel-test.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Supervisor } = require(path.join(ROOT, 'desktop', 'lib', 'supervisor.js'));
const { ManagedProcess } = require(path.join(ROOT, 'desktop', 'lib', 'procman.js'));
const { LogBuffer } = require(path.join(ROOT, 'desktop', 'lib', 'logbuf.js'));

let passed = 0, failed = 0, skipped = 0; const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✘ ${name} ${extra}`); }
};
const skip = (name, why) => { skipped++; console.log(`  – ${name} (${why})`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-tunnel-'));
const proj = path.join(tmp, 'proj');
await fsp.mkdir(path.join(proj, 'cloudflared'), { recursive: true });
const credFile = path.join(tmp, 'creds.json');
await fsp.writeFile(credFile, JSON.stringify({ AccountTag: 'x', TunnelSecret: 'c2VjcmV0', TunnelID: '451d9ecf-d503-4309-bd3a-0974ee86a5e3' }));
const cfgFile = path.join(proj, 'cloudflared', 'config.yml');
const writeCfg = (extra = '') => fs.writeFileSync(cfgFile,
  `tunnel: 451d9ecf-d503-4309-bd3a-0974ee86a5e3\ncredentials-file: ${credFile}\n${extra}ingress:\n  - hostname: cloud.example.com\n    service: http://localhost:3000\n  - service: http_status:404\n`);
writeCfg();

// Supervisor with a home that has no ~/.cloudflared, so the project config is chosen
const sup = new Supervisor({ projectRoot: proj, getAppConfig: () => ({}) });
sup.webPort = 3000;
const argsFor = (cfg) => sup.buildTunnelSpec(cfg, proj).args;

console.log('\n— command construction');
{
  const named = argsFor({ tunnelMode: 'named', tunnelName: 'nimbus' });
  const iCfg = named.indexOf('--config');
  const iRun = named.indexOf('run');
  check('named mode passes --config', iCfg > -1, JSON.stringify(named));
  check('--config comes BEFORE "run" (the whole bug)', iCfg > -1 && iRun > -1 && iCfg < iRun, JSON.stringify(named));
  check('command starts with "tunnel"', named[0] === 'tunnel');
  check('tunnel name is last', named[named.length - 1] === 'nimbus', JSON.stringify(named));

  const token = argsFor({ tunnelMode: 'token', tunnelToken: '  TOKEN123  ' });
  check('token mode uses "tunnel run --token" and trims', JSON.stringify(token) === JSON.stringify(['tunnel', 'run', '--token', 'TOKEN123']), JSON.stringify(token));

  const quick = argsFor({ tunnelMode: 'quick' });
  check('quick mode points at the live web port', JSON.stringify(quick) === JSON.stringify(['tunnel', '--url', 'http://localhost:3000']), JSON.stringify(quick));

  sup.webPort = 3007;
  check('quick mode follows a healed port', argsFor({ tunnelMode: 'quick' })[2] === 'http://localhost:3007');
  sup.webPort = 3000;

  let threw = null;
  try { argsFor({ tunnelMode: 'token', tunnelToken: '   ' }); } catch (e) { threw = e.message; }
  check('token mode without a token explains itself', !!threw && /token/i.test(threw), String(threw));
}

console.log('\n— preflight (fail with a reason, not a crash loop)');
{
  writeCfg();
  let ok = true; try { argsFor({ tunnelMode: 'named' }); } catch { ok = false; }
  check('valid config passes preflight', ok);

  fs.writeFileSync(cfgFile, `tunnel: abc\ncredentials-file: ${path.join(tmp, 'gone.json')}\ningress:\n  - hostname: h\n    service: http://localhost:3000\n`);
  let msg = null; try { argsFor({ tunnelMode: 'named' }); } catch (e) { msg = e.message; }
  check('missing credentials file is caught', !!msg && /credentials file[\s\S]*is missing/i.test(msg), String(msg));
  check('…and says how to fix it', !!msg && /tunnel create|Copy it from/i.test(msg));

  fs.writeFileSync(cfgFile, 'tunnel: abc\n# no ingress at all\n');
  msg = null; try { argsFor({ tunnelMode: 'named' }); } catch (e) { msg = e.message; }
  check('config without ingress rules is caught', !!msg && /ingress/i.test(msg), String(msg));
  writeCfg();
}

console.log('\n— the port the tunnel serves follows the website');
{
  writeCfg();
  sup.webPort = 3011;
  argsFor({ tunnelMode: 'named' });
  const txt = fs.readFileSync(cfgFile, 'utf8');
  check('config.yml service port rewritten to the live port', /service: http:\/\/localhost:3011/.test(txt), txt.split('\n').find((l) => l.includes('service:')));
  sup.webPort = 3000;
  writeCfg();
}

console.log('\n— failures report what the process actually said');
{
  const log = new LogBuffer({ name: 'test' });
  const p = new ManagedProcess({
    name: 'tunnel', log, backoff: [50, 50], maxRestarts: 1, windowMs: 60000,
    getSpec: () => ({ cmd: process.execPath, args: ['-e', 'console.error("Incorrect Usage: flag provided but not defined: -config"); process.exit(0)'], cwd: tmp }),
  });
  const failure = new Promise((res) => p.once('failed', res));
  p.start();
  const info = await Promise.race([failure, sleep(8000).then(() => null)]);
  await p.stop();
  check('the real error reaches the UI, not "exited with code 0"',
    !!info && /Incorrect Usage/.test(info.error), JSON.stringify(info));
}

console.log('\n— against the real cloudflared binary');
{
  const candidates = [process.env.CLOUDFLARED_BIN, '/tmp/cloudflared', 'cloudflared'].filter(Boolean);
  let bin = null;
  for (const c of candidates) {
    if (c.includes('/') ? fs.existsSync(c) : await new Promise((r) => execFile('which', [c], (e, o) => r(!e && !!o.trim())))) { bin = c; break; }
  }
  if (!bin) {
    skip('real cloudflared parses the built command', 'binary not available here');
  } else {
    writeCfg();
    const args = argsFor({ tunnelMode: 'named', tunnelName: 'nimbus' });
    const out = await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: proj });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.stderr.on('data', (d) => { buf += d; });
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(buf); }, 6000);
      child.on('exit', () => resolve(buf));
    });
    check('cloudflared accepts the command (no "Incorrect Usage")', !/Incorrect Usage/i.test(out), out.split('\n')[0]);
    check('cloudflared actually starts the tunnel', /Starting tunnel|Registered tunnel connection|Initial protocol/i.test(out), out.split('\n').slice(0, 2).join(' | '));

    // and prove the OLD form really was broken (guards against silent regression)
    const oldArgs = ['tunnel', 'run', '--config', cfgFile, 'nimbus'];
    const oldOut = await new Promise((resolve) => {
      const child = spawn(bin, oldArgs, { cwd: proj });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.stderr.on('data', (d) => { buf += d; });
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(buf); }, 6000);
      child.on('exit', () => resolve(buf));
    });
    check('the old argument order is confirmed broken', /Incorrect Usage/i.test(oldOut), oldOut.split('\n')[0]);
  }
}

console.log('\n— tunnel mode reaches the supervisor at all (the "token mode is ignored" bug)');
{
  // main.js builds the object handed to Supervisor via getAppConfig(). It used
  // to list only tunnelEnabled/tunnelName/cloudflaredPath/nodePath, so
  // buildTunnelSpec saw mode === undefined, fell back to 'named', and demanded a
  // config.yml + credentials file even when the user had chosen token mode and
  // pasted a token. Guard the wiring, not just the command builder.
  const mainSrc = await fsp.readFile(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  const supBlock = /getAppConfig:\s*\(\)\s*=>\s*\(\{([\s\S]*?)\}\),/.exec(mainSrc);
  check('main.js has a getAppConfig block', !!supBlock);
  if (supBlock) {
    check('getAppConfig forwards tunnelMode', /\btunnelMode\b/.test(supBlock[1]), supBlock[1].trim());
    check('getAppConfig forwards tunnelToken', /\btunnelToken\b/.test(supBlock[1]), supBlock[1].trim());
  }
  const stateBlock = /config:\s*\{([\s\S]*?)\},/.exec(mainSrc);
  check('publicState exposes tunnelMode to the renderer', !!stateBlock && /\btunnelMode\b/.test(stateBlock[1]));
  check('publicState exposes tunnelToken (else saving Settings wipes it)', !!stateBlock && /\btunnelToken\b/.test(stateBlock[1]));

  // and the behaviour that wiring enables: token mode wins even when a named
  // config exists on disk
  writeCfg();
  const t = argsFor({ tunnelMode: 'token', tunnelToken: 'eyJhIjoiYiJ9', tunnelName: 'nimbus' });
  check('token mode ignores an existing named config', JSON.stringify(t) === JSON.stringify(['tunnel', 'run', '--token', 'eyJhIjoiYiJ9']), JSON.stringify(t));
}

console.log('\n— named mode failures explain themselves');
{
  const HOME0 = process.env.HOME, UP0 = process.env.USERPROFILE;
  const fakeHome = path.join(tmp, 'home', 'me');
  await fsp.mkdir(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  // (a) no config anywhere
  const bare = path.join(tmp, 'bare');
  await fsp.mkdir(bare, { recursive: true });
  let err = null;
  try { sup.buildTunnelSpec({ tunnelMode: 'named', tunnelName: 'nimbus' }, bare); } catch (e) { err = e; }
  check('missing config throws instead of spawning a doomed cloudflared', !!err);
  check('...and names the file it looked for', !!err && err.message.includes('.cloudflared'), err && err.message);
  check('...and offers token mode as the easy way out', !!err && /Permanent Custom Domain/.test(err.message), err && err.message);

  // (b) config present, credentials file missing
  const credGone = path.join(tmp, 'credgone');
  await fsp.mkdir(path.join(credGone, 'cloudflared'), { recursive: true });
  const otherCred = process.platform === 'win32'
    ? 'C:\\Users\\someoneelse\\.cloudflared\\451d9ecf.json'
    : '/home/someoneelse/.cloudflared/451d9ecf.json';
  await fsp.writeFile(path.join(credGone, 'cloudflared', 'config.yml'),
    `tunnel: 451d9ecf\ncredentials-file: ${otherCred}\ningress:\n  - hostname: cloud.example.com\n    service: http://localhost:3000\n  - service: http_status:404\n`);
  err = null;
  try { sup.buildTunnelSpec({ tunnelMode: 'named', tunnelName: 'nimbus' }, credGone); } catch (e) { err = e; }
  check('missing credentials file throws', !!err);
  check('...names the config that referenced it', !!err && err.message.includes('config.yml'), err && err.message);
  check('...flags that the path belongs to another user', !!err && /belongs to the user "someoneelse"/.test(err.message), err && err.message);
  check('...says the file is never shipped with the code', !!err && /never shipped with the code/.test(err.message));
  check('...offers token mode', !!err && /Permanent Custom Domain/.test(err.message));
  check('...prints the right create command', !!err && err.message.includes('cloudflared tunnel create nimbus'), err && err.message);

  // (c) same config but the credentials file exists -> no throw
  const credOk = path.join(tmp, 'credok');
  await fsp.mkdir(path.join(credOk, 'cloudflared'), { recursive: true });
  await fsp.writeFile(path.join(credOk, 'cloudflared', 'config.yml'),
    `tunnel: 451d9ecf\ncredentials-file: ${credFile}\ningress:\n  - hostname: cloud.example.com\n    service: http://localhost:3000\n  - service: http_status:404\n`);
  let ok = null, err2 = null;
  try { ok = sup.buildTunnelSpec({ tunnelMode: 'named', tunnelName: 'nimbus' }, credOk); } catch (e) { err2 = e; }
  check('a valid named config still builds a command', !!ok && !err2, err2 && err2.message);

  process.env.HOME = HOME0; process.env.USERPROFILE = UP0;
  if (HOME0 === undefined) delete process.env.HOME;
  if (UP0 === undefined) delete process.env.USERPROFILE;
}

console.log('\n— the repo must not ship anyone\'s personal tunnel config');
{
  const isRepo = await new Promise((resolve) => {
    execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT }, (e, out) => resolve(!e && /true/.test(String(out))));
  });
  const certs = ['cloudflared/cert.pem', 'cloudflared/config.yml'];
  for (const rel of certs) {
    if (!isRepo) { skip(`${rel} is NOT tracked by git`, 'not a git checkout here'); continue; }
    const tracked = await new Promise((resolve) => {
      execFile('git', ['ls-files', '--error-unmatch', rel], { cwd: ROOT }, (e) => resolve(!e));
    });
    check(`${rel} is NOT tracked by git`, !tracked, tracked ? 'still committed — it ships to every user' : '');
  }
}

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n══ tunnel: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
