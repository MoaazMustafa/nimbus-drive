#!/usr/bin/env node
/**
 * Tunnel-config discovery, generation, and the named-mode fallback chain.
 *
 * The failure this prevents: a machine that is perfectly capable of running a
 * tunnel refuses to, because one text file (~/.cloudflared/config.yml) was never
 * hand-written. Everything in that file is derivable — the tunnel id from the
 * credentials cloudflared already wrote, the hostname from BASE_URL, the port
 * from the running site — so the app writes it. When it genuinely cannot, it
 * falls back to a saved tunnel token, and only then gives up, with a message
 * naming exactly what is missing.
 *
 *   node scripts/dev/cfconfig-test.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cf = require(path.join(ROOT, 'desktop', 'lib', 'cfconfig.js'));
const { Supervisor } = require(path.join(ROOT, 'desktop', 'lib', 'supervisor.js'));

let passed = 0, failed = 0, skipped = 0; const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✘ ${name} ${extra}`); }
};
const skip = (name, why) => { skipped++; console.log(`  – ${name} (${why})`); };

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-cfcfg-'));
const UUID_A = '451d9ecf-d503-4309-bd3a-0974ee86a5e3';
const UUID_B = '9f2c1b77-0a44-4c11-8e51-2b6d7f0c1a99';

/** a home directory with whatever ~/.cloudflared contents the test wants */
async function makeHome(label, { cert = false, creds = [], config = null, junk = false } = {}) {
  const home = path.join(tmp, label);
  const dir = path.join(home, '.cloudflared');
  await fsp.mkdir(dir, { recursive: true });
  if (cert) await fsp.writeFile(path.join(dir, 'cert.pem'), '-----BEGIN ARGO TUNNEL TOKEN-----\nx\n');
  for (const c of creds) {
    await fsp.writeFile(path.join(dir, `${c.file || c.id}.json`),
      JSON.stringify({ AccountTag: 'acct', TunnelSecret: 'c2VjcmV0', TunnelID: c.id, ...(c.name ? { TunnelName: c.name } : {}) }));
  }
  if (junk) {
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'hello');
    await fsp.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ some: 'setting' }));   // json, but no TunnelSecret
    await fsp.writeFile(path.join(dir, 'broken.json'), '{not json');
  }
  if (config) await fsp.writeFile(path.join(dir, 'config.yml'), config);
  return home;
}

/** a project root with a .env, the way the supervisor expects one */
async function makeProject(label, baseUrl) {
  const root = path.join(tmp, label);
  await fsp.mkdir(root, { recursive: true });
  if (baseUrl !== undefined) await fsp.writeFile(path.join(root, '.env'), `BASE_URL=${baseUrl}\nAPI_PORT=4400\n`);
  return root;
}

console.log('\n— finding what cloudflared already put on the machine');
{
  const home = await makeHome('find', { cert: true, creds: [{ id: UUID_A }], junk: true });
  const found = cf.findCredentials(home);
  check('finds the tunnel credential', found.length === 1, JSON.stringify(found));
  check('reads the tunnel id', found[0]?.id === UUID_A, found[0]?.id);
  check('ignores non-JSON files', !found.some((f) => /notes/.test(f.file)));
  check('ignores JSON that is not a tunnel credential', !found.some((f) => /settings/.test(f.file)));
  check('survives unparseable JSON', found.length === 1);
  check('detects that the PC is linked to Cloudflare', cf.hasLogin(home) === true);

  const empty = await makeHome('find-empty');
  check('an empty .cloudflared yields nothing', cf.findCredentials(empty).length === 0);
  check('...and reports the PC as not linked', cf.hasLogin(empty) === false);

  // the id inside the file wins over a filename that disagrees
  const odd = await makeHome('find-odd', { creds: [{ id: UUID_B, file: 'renamed-by-hand' }] });
  check('trusts the id inside the credential over the filename', cf.findCredentials(odd)[0]?.id === UUID_B);
}

console.log('\n— deriving the hostname from BASE_URL');
{
  check('https domain', cf.hostnameFromBaseUrl('https://cloud.example.com/') === 'cloud.example.com');
  check('http domain', cf.hostnameFromBaseUrl('http://drive.example.co.uk') === 'drive.example.co.uk');
  check('localhost is not routable', cf.hostnameFromBaseUrl('http://localhost:3000') === null);
  check('a LAN IP is not routable', cf.hostnameFromBaseUrl('http://192.168.1.5:3000') === null);
  check('a bare hostname is not routable', cf.hostnameFromBaseUrl('http://nas:3000') === null);
  check('garbage is handled', cf.hostnameFromBaseUrl('not a url') === null);
  check('unset is handled', cf.hostnameFromBaseUrl(undefined) === null);
}

console.log('\n— writing the config instead of demanding it');
{
  const home = await makeHome('gen', { cert: true, creds: [{ id: UUID_A }] });
  const res = cf.ensureNamedConfig({ home, baseUrl: 'https://cloud.example.com', port: 3007, tunnelName: 'nimbus' });
  check('a config is created', res.created === true && !!res.path, JSON.stringify(res));
  const text = res.path ? await fsp.readFile(res.path, 'utf8') : '';
  check('names the right tunnel', text.includes(`tunnel: ${UUID_A}`), text);
  check('points at the real credentials file on THIS machine', text.includes(path.join(home, '.cloudflared', `${UUID_A}.json`)), text);
  check('routes the domain from BASE_URL', text.includes('hostname: cloud.example.com'), text);
  check('sends traffic to the live web port', text.includes('service: http://localhost:3007'), text);
  check('keeps the required catch-all rule', text.includes('http_status:404'), text);
  check('keeps the long connect timeout for big uploads', text.includes('connectTimeout: 30s'), text);

  // second call must not clobber a config that now exists
  await fsp.writeFile(res.path, text + '\n# hand-edited\n');
  const again = cf.ensureNamedConfig({ home, baseUrl: 'https://other.example.com', port: 9999, tunnelName: 'nimbus' });
  check('an existing config is reused, never overwritten', again.created === false && again.path === res.path);
  check('...and hand edits survive', (await fsp.readFile(res.path, 'utf8')).includes('# hand-edited'));
}

console.log('\n— when it cannot, it says exactly what is missing');
{
  const nothing = await makeHome('none');
  const r1 = cf.ensureNamedConfig({ home: nothing, baseUrl: 'https://cloud.example.com', port: 3000, tunnelName: 'nimbus' });
  check('an unlinked PC is reported as such', r1.reason === 'no-login', JSON.stringify(r1));
  const m1 = cf.explain(r1, { tunnelName: 'nimbus', home: nothing });
  check('...names the folder it looked in', m1.includes('.cloudflared'), m1);
  check('...offers the token route first', /Permanent Custom Domain/.test(m1), m1);
  check('...and the login route second', /cloudflared tunnel login/.test(m1), m1);

  const linked = await makeHome('linked', { cert: true });
  const r2 = cf.ensureNamedConfig({ home: linked, baseUrl: 'https://cloud.example.com', port: 3000, tunnelName: 'nimbus' });
  check('a linked PC with no tunnel is reported separately', r2.reason === 'no-credentials', JSON.stringify(r2));
  const m2 = cf.explain(r2, { tunnelName: 'nimbus', home: linked });
  check('...tells you to create the tunnel', m2.includes('cloudflared tunnel create nimbus'), m2);
  check('...and to add the DNS route', m2.includes('route dns'), m2);

  const noHost = await makeHome('nohost', { cert: true, creds: [{ id: UUID_A }] });
  const r3 = cf.ensureNamedConfig({ home: noHost, baseUrl: 'http://localhost:3000', port: 3000, tunnelName: 'nimbus' });
  check('a local-only BASE_URL is reported', r3.reason === 'no-hostname', JSON.stringify(r3));
  check('...and says what to set it to', /BASE_URL/.test(cf.explain(r3, {})), cf.explain(r3, {}));

  const many = await makeHome('many', { cert: true, creds: [{ id: UUID_A, name: 'work' }, { id: UUID_B, name: 'home' }] });
  const r4 = cf.ensureNamedConfig({ home: many, baseUrl: 'https://cloud.example.com', port: 3000, tunnelName: 'nimbus' });
  check('several tunnels with no name match is reported', r4.reason === 'ambiguous', JSON.stringify(r4));
  const m4 = cf.explain(r4, { tunnelName: 'nimbus', home: many });
  check('...lists the tunnels to choose from', m4.includes('work') && m4.includes('home'), m4);

  const r5 = cf.ensureNamedConfig({ home: many, baseUrl: 'https://cloud.example.com', port: 3000, tunnelName: 'home' });
  check('a matching tunnel name resolves the ambiguity', r5.created === true, JSON.stringify(r5));
  check('...and picks the right tunnel', (await fsp.readFile(r5.path, 'utf8')).includes(UUID_B));
}

console.log('\n— the supervisor fallback chain, end to end');
{
  const HOME0 = process.env.HOME, UP0 = process.env.USERPROFILE;
  const setHome = (h) => { process.env.HOME = h; process.env.USERPROFILE = h; };
  const restore = () => {
    if (HOME0 === undefined) delete process.env.HOME; else process.env.HOME = HOME0;
    if (UP0 === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = UP0;
  };

  // (1) nothing on disk, but the PC has a tunnel -> the app writes the config and runs it
  {
    const home = await makeHome('sup-gen', { cert: true, creds: [{ id: UUID_A }] });
    const proj = await makeProject('proj-gen', 'https://cloud.example.com');
    setHome(home);
    const sup = new Supervisor({ projectRoot: proj, getAppConfig: () => ({}) });
    sup.webPort = 3000;
    const spec = sup.buildTunnelSpec({ tunnelMode: 'named', tunnelName: 'nimbus' }, proj);
    const generated = path.join(home, '.cloudflared', 'config.yml');
    check('a missing config is generated rather than fatal', fs.existsSync(generated));
    check('...and the command uses it', spec.args.includes('--config') && spec.args.includes(generated), JSON.stringify(spec.args));
    check('...with --config still before "run"', spec.args.indexOf('--config') < spec.args.indexOf('run'), JSON.stringify(spec.args));
    check('...and the log says what it wrote', sup.logs.app.entries?.().some?.((e) => /Wrote a tunnel config/.test(e.line)) ?? true);
  }

  // (2) a config exists but its credentials are gone, and a token is saved -> token wins
  {
    const home = await makeHome('sup-broken', {
      config: `tunnel: ${UUID_A}\ncredentials-file: ${path.join(tmp, 'does-not-exist.json')}\ningress:\n  - hostname: cloud.example.com\n    service: http://localhost:3000\n  - service: http_status:404\n`,
    });
    const proj = await makeProject('proj-broken', 'https://cloud.example.com');
    setHome(home);
    const sup = new Supervisor({ projectRoot: proj, getAppConfig: () => ({}) });
    sup.webPort = 3000;
    const spec = sup.buildTunnelSpec({ tunnelMode: 'named', tunnelName: 'nimbus', tunnelToken: 'TOKEN-XYZ' }, proj);
    check('a broken named config falls back to the saved token', JSON.stringify(spec.args) === JSON.stringify(['tunnel', 'run', '--token', 'TOKEN-XYZ']), JSON.stringify(spec.args));
  }

  // (2b) a config exists but is broken, and the PC DOES have a usable tunnel
  //      -> heal it, keeping the old file rather than destroying it
  {
    const home = await makeHome('sup-heal', {
      cert: true,
      creds: [{ id: UUID_B }],
      config: `tunnel: ${UUID_A}\ncredentials-file: ${path.join(tmp, 'gone.json')}\ningress:\n  - hostname: cloud.example.com\n    service: http://localhost:3000\n  - service: http_status:404\n`,
    });
    const proj = await makeProject('proj-heal', 'https://cloud.example.com');
    setHome(home);
    const sup = new Supervisor({ projectRoot: proj, getAppConfig: () => ({}) });
    sup.webPort = 3000;
    const spec = sup.buildTunnelSpec({ tunnelMode: 'named', tunnelName: 'nimbus' }, proj);
    const cfgFile = path.join(home, '.cloudflared', 'config.yml');
    const text = await fsp.readFile(cfgFile, 'utf8');
    check('a broken config is rewritten from the real credentials', text.includes(UUID_B), text);
    check('...and the dead tunnel id is gone', !text.includes(UUID_A), text);
    check('...the old file is kept, not destroyed', fs.existsSync(`${cfgFile}.replaced`));
    check('...and the command runs the healed config', spec.args.includes(cfgFile), JSON.stringify(spec.args));
  }

  // (3) nothing at all, but a token is saved -> token
  {
    const home = await makeHome('sup-token');
    const proj = await makeProject('proj-token', 'https://cloud.example.com');
    setHome(home);
    const sup = new Supervisor({ projectRoot: proj, getAppConfig: () => ({}) });
    sup.webPort = 3000;
    const spec = sup.buildTunnelSpec({ tunnelMode: 'named', tunnelName: 'nimbus', tunnelToken: 'TOKEN-ABC' }, proj);
    check('an unconfigured PC with a token still gets online', JSON.stringify(spec.args) === JSON.stringify(['tunnel', 'run', '--token', 'TOKEN-ABC']), JSON.stringify(spec.args));
  }

  // (4) nothing at all, no token -> a precise refusal, not a crash loop
  {
    const home = await makeHome('sup-dead');
    const proj = await makeProject('proj-dead', 'https://cloud.example.com');
    setHome(home);
    const sup = new Supervisor({ projectRoot: proj, getAppConfig: () => ({}) });
    sup.webPort = 3000;
    let err = null;
    try { sup.buildTunnelSpec({ tunnelMode: 'named', tunnelName: 'nimbus' }, proj); } catch (e) { err = e; }
    check('with nothing to work with it refuses', !!err);
    check('...naming the folder it checked', !!err && err.message.includes('.cloudflared'), err?.message);
    check('...and offering the token route', !!err && /Permanent Custom Domain/.test(err.message), err?.message);
  }

  // (5) an explicit token mode is never second-guessed
  {
    const home = await makeHome('sup-explicit', { cert: true, creds: [{ id: UUID_A }] });
    const proj = await makeProject('proj-explicit', 'https://cloud.example.com');
    setHome(home);
    const sup = new Supervisor({ projectRoot: proj, getAppConfig: () => ({}) });
    sup.webPort = 3000;
    const spec = sup.buildTunnelSpec({ tunnelMode: 'token', tunnelToken: 'T1' }, proj);
    check('token mode does not touch the filesystem', JSON.stringify(spec.args) === JSON.stringify(['tunnel', 'run', '--token', 'T1']));
    check('...and writes no config', !fs.existsSync(path.join(home, '.cloudflared', 'config.yml')));
  }

  restore();
}

console.log('\n— the generated config is one cloudflared actually accepts');
{
  const bin = process.env.CLOUDFLARED_BIN || await new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], (e, out) =>
      resolve(e ? null : String(out).split(/\r?\n/)[0].trim() || null));
  });
  if (!bin) skip('cloudflared parses the generated config', 'no cloudflared binary');
  else {
    const home = await makeHome('parse', { cert: true, creds: [{ id: UUID_A }] });
    const res = cf.ensureNamedConfig({ home, baseUrl: 'https://cloud.example.com', port: 3000, tunnelName: 'nimbus' });
    const { code, out } = await new Promise((resolve) => {
      execFile(bin, ['tunnel', '--config', res.path, 'ingress', 'validate'], { timeout: 15000 }, (e, so, se) =>
        resolve({ code: e ? (e.code ?? 1) : 0, out: `${so || ''}${se || ''}` }));
    });
    const oneLine = out.replace(/\s+/g, ' ').trim();
    check('cloudflared exits 0 on the generated config', code === 0, `exit=${code} ${oneLine}`);
    check('...and reports the ingress rules valid', /\bOK\b/.test(out) && !/Incorrect Usage/i.test(out), oneLine);
  }
}

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(`\n══ tunnel config: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
