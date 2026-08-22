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
  check('missing credentials file is caught', !!msg && /credentials file is missing/i.test(msg), String(msg));
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

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n══ tunnel: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
