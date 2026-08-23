#!/usr/bin/env node
/**
 * Exercises the domain & sign-in verifier against mock servers that stand in
 * for: the local drive, the public tunnel endpoint, and Google's OAuth screen.
 *
 *   node scripts/dev/verify-test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { runDiagnostics } = require(path.join(ROOT, 'desktop', 'lib', 'verify.js'));

let passed = 0, failed = 0; const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✘ ${name} ${extra}`); }
};
const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const statusOf = (out, id) => out.checks.find((c) => c.id === id)?.status;
const detailOf = (out, id) => out.checks.find((c) => c.id === id) || {};

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-verify-'));

// ── mocks ───────────────────────────────────────────────────────────
const state = {
  apiApp: 'Nimbus Drive',
  publicApp: 'Nimbus Drive',
  publicMode: 'ok',        // ok | 502 | down
  googleMode: 'ok',        // ok | mismatch | invalid_client
  redirectUri: null,       // what the "live site" tells Google
};

const apiSrv = http.createServer((req, res) => json(res, 200, { ok: true, app: state.apiApp, problems: [] }));
const webSrv = http.createServer((req, res) => json(res, 200, { ok: true, app: state.apiApp, problems: [] }));
const apiPort = await listen(apiSrv);
const webPort = await listen(webSrv);

const pubSrv = http.createServer((req, res) => {
  if (state.publicMode === '502') { res.writeHead(502); return res.end('Bad gateway'); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, app: state.publicApp, problems: [] });
  if (url.pathname === '/api/auth/google') {
    const ru = state.redirectUri ?? 'https://cloud.test/api/auth/callback/google';
    res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=${encodeURIComponent(ru)}&response_type=code` });
    return res.end();
  }
  res.writeHead(404); res.end('nope');
});
const pubPort = await listen(pubSrv);

const googleSrv = http.createServer((req, res) => {
  if (state.googleMode === 'mismatch') { res.writeHead(400, { 'content-type': 'text/html' }); return res.end('<html>Error 400: redirect_uri_mismatch</html>'); }
  if (state.googleMode === 'invalid_client') { res.writeHead(401, { 'content-type': 'text/html' }); return res.end('<html>Error: invalid_client</html>'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Sign in with Google — choose an account</html>');
});
const googlePort = await listen(googleSrv);

/** Pretends cloud.test is served by the tunnel, and accounts.google.com by our mock. */
const fetchImpl = (url, opts) => {
  let u = String(url);
  if (state.publicMode === 'down' && u.startsWith('https://cloud.test')) return Promise.reject(new Error('getaddrinfo ENOTFOUND'));
  u = u.replace('https://cloud.test', `http://127.0.0.1:${pubPort}`)
       .replace('https://accounts.google.com', `http://127.0.0.1:${googlePort}`);
  return fetch(u, opts);
};
const dnsOk = { resolve: async () => ['104.21.5.5'] };
const dnsMissing = { resolve: async () => { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e; } };
// the shape that produced a self-contradicting report: the nameserver path is
// refused on this PC, while the OS resolver answers fine
const refuse = (code) => async () => { const e = new Error(code); e.code = code; throw e; };
const dnsRefused = { resolve4: refuse('ECONNREFUSED'), resolve: refuse('ECONNREFUSED'), resolve6: refuse('ECONNREFUSED'), resolveCname: refuse('ECONNREFUSED'), lookup: refuse('ECONNREFUSED') };
const dnsOsOnly = {
  resolve4: refuse('ECONNREFUSED'), resolve: refuse('ECONNREFUSED'),
  resolve6: refuse('ENODATA'), resolveCname: refuse('ENOTFOUND'),
  lookup: async () => [{ address: '104.21.5.5', family: 4 }],
};

// a cloudflared config that routes cloud.test to the right port
const projectRoot = path.join(tmp, 'proj');
await fsp.mkdir(path.join(projectRoot, 'cloudflared'), { recursive: true });
const writeCfg = (host, port) => fs.writeFileSync(path.join(projectRoot, 'cloudflared', 'config.yml'),
  `tunnel: abc-123\ningress:\n  - hostname: ${host}\n    service: http://localhost:${port}\n  - service: http_status:404\n`);
writeCfg('cloud.test', webPort);

const baseOpts = () => ({
  env: { BASE_URL: 'https://cloud.test', GOOGLE_CLIENT_ID: 'abc', GOOGLE_CLIENT_SECRET: 'shh', APP_NAME: 'Nimbus Drive' },
  apiPort, webPort, tunnelEnabled: true, tunnelMode: 'named',
  projectRoot, homeDir: tmp, fetchImpl, dns: dnsOk,
});

try {
  console.log('\n— everything healthy (the state we want the family PC in)');
  let out = await runDiagnostics(baseOpts());
  check('overall verdict is OK', out.overall === 'ok', JSON.stringify(out.checks.filter(c => c.status !== 'ok')));
  check('local engine + website verified', statusOf(out, 'local-api') === 'ok' && statusOf(out, 'local-web') === 'ok');
  check('domain resolves', statusOf(out, 'dns') === 'ok');
  check('tunnel routing matches hostname AND port', statusOf(out, 'tunnel-route') === 'ok', detailOf(out, 'tunnel-route').detail);
  check('public address served by THIS pc', statusOf(out, 'public') === 'ok');
  check('sign-in hand-off correct', statusOf(out, 'oauth-redirect') === 'ok');
  check('Google accepts the return address', statusOf(out, 'oauth-google') === 'ok');
  check('reports the exact redirect URI', out.redirectUri === 'https://cloud.test/api/auth/callback/google');

  console.log('\n— Google rejects the return address (the classic browser-login killer)');
  state.googleMode = 'mismatch';
  out = await runDiagnostics(baseOpts());
  check('caught as a failure', statusOf(out, 'oauth-google') === 'fail');
  check('fix names the exact URI to paste into Google Console',
    (detailOf(out, 'oauth-google').fix || '').includes('https://cloud.test/api/auth/callback/google'));
  check('overall verdict fails', out.overall === 'fail');
  state.googleMode = 'ok';

  console.log('\n— wrong Client ID');
  state.googleMode = 'invalid_client';
  out = await runDiagnostics(baseOpts());
  check('invalid_client detected', statusOf(out, 'oauth-google') === 'fail' && /Client ID/i.test(detailOf(out, 'oauth-google').detail));
  state.googleMode = 'ok';

  console.log('\n— tunnel up but app down (Cloudflare 502)');
  state.publicMode = '502';
  out = await runDiagnostics(baseOpts());
  check('public reachability fails', statusOf(out, 'public') === 'fail');
  check('fix explains the 502 specifically', /tunnel points at the right port/i.test(detailOf(out, 'public').fix || ''));
  check('sign-in checks skip rather than mislead', statusOf(out, 'oauth-redirect') === 'skip');
  state.publicMode = 'ok';

  console.log('\n— domain not reachable at all');
  state.publicMode = 'down';
  out = await runDiagnostics(baseOpts());
  check('reported as unreachable', statusOf(out, 'public') === 'fail');
  state.publicMode = 'ok';

  console.log('\n— DNS record missing');
  state.publicMode = 'down';
  out = await runDiagnostics({ ...baseOpts(), dns: dnsMissing });
  check('DNS failure surfaced', statusOf(out, 'dns') === 'fail', statusOf(out, 'dns'));
  check('fix mentions the CNAME to create', /cfargotunnel\.com/.test(detailOf(out, 'dns').fix || ''));
  state.publicMode = 'ok';

  console.log('\n— the report never contradicts itself');
  {
    // the screenshot that started this: "does not resolve (ECONNREFUSED)" sitting
    // directly above "is live and served by THIS PC". Both cannot be true, and
    // the reachable address is the stronger evidence.
    out = await runDiagnostics({ ...baseOpts(), dns: dnsRefused });
    check('a reachable address is reported reachable', statusOf(out, 'public') === 'ok', statusOf(out, 'public'));
    check('...so DNS is not reported as broken', statusOf(out, 'dns') !== 'fail', statusOf(out, 'dns'));
    check('...it is a warning about THIS PC, not the domain', statusOf(out, 'dns') === 'warn');
    check('...and says the name is in fact resolving', /is resolving/.test(detailOf(out, 'dns').detail || ''), detailOf(out, 'dns').detail);
    check('...and names what was actually refused', /ECONNREFUSED/.test(detailOf(out, 'dns').detail || ''), detailOf(out, 'dns').detail);
    check('...and tells the owner there is nothing to fix', /Nothing to fix/.test(detailOf(out, 'dns').fix || ''), detailOf(out, 'dns').fix);
    check('...and the overall verdict is no longer "problem found"', out.overall !== 'fail', out.overall);

    // when only the OS resolver answers, that is a clean pass — not a warning
    out = await runDiagnostics({ ...baseOpts(), dns: dnsOsOnly });
    check('the OS resolver alone is enough to pass', statusOf(out, 'dns') === 'ok', statusOf(out, 'dns'));
    check('...and the report says which path answered', /resolver/.test(detailOf(out, 'dns').detail || ''), detailOf(out, 'dns').detail);

    // and a genuinely missing record with nothing reachable still fails loudly
    state.publicMode = 'down';
    out = await runDiagnostics({ ...baseOpts(), dns: dnsRefused });
    check('a truly dead domain still fails', statusOf(out, 'dns') === 'fail', statusOf(out, 'dns'));
    state.publicMode = 'ok';
  }

  console.log('\n— tunnel routes the wrong port (the silent 502 maker)');
  writeCfg('cloud.test', webPort + 7);
  out = await runDiagnostics(baseOpts());
  check('port mismatch caught', statusOf(out, 'tunnel-route') === 'fail');
  check('fix names both ports', new RegExp(`${webPort}`).test(detailOf(out, 'tunnel-route').fix || ''));
  writeCfg('cloud.test', webPort);

  console.log('\n— tunnel routes a different hostname');
  writeCfg('other.example.com', webPort);
  out = await runDiagnostics(baseOpts());
  check('hostname mismatch caught', statusOf(out, 'tunnel-route') === 'fail', detailOf(out, 'tunnel-route').detail);
  writeCfg('cloud.test', webPort);

  console.log('\n— quick tunnel selected with a custom domain');
  out = await runDiagnostics({ ...baseOpts(), tunnelMode: 'quick' });
  check('quick mode flagged as unable to serve the domain', statusOf(out, 'tunnel-mode') === 'fail');
  check('fix points at named tunnel', /named tunnel/i.test(detailOf(out, 'tunnel-mode').fix || ''));

  console.log('\n— domain answers, but from a different machine');
  state.publicApp = 'Someone Elses Drive';
  out = await runDiagnostics(baseOpts());
  check('mismatch warned, not silently passed', statusOf(out, 'public') === 'warn');
  state.publicApp = 'Nimbus Drive';

  console.log('\n— local-only setup does not pretend to check the internet');
  out = await runDiagnostics({ ...baseOpts(), env: { ...baseOpts().env, BASE_URL: 'http://localhost:3000' } });
  check('public checks skipped', statusOf(out, 'public') === 'skip');
  check('address flagged as local-only', statusOf(out, 'config') === 'warn');

  console.log('\n— http:// domain (insecure) is rejected');
  out = await runDiagnostics({ ...baseOpts(), env: { ...baseOpts().env, BASE_URL: 'http://cloud.test' } });
  check('http domain fails config check', statusOf(out, 'config') === 'fail');
} catch (err) {
  failed++; fails.push('unexpected: ' + err.message);
  console.error(err);
} finally {
  apiSrv.close(); webSrv.close(); pubSrv.close(); googleSrv.close();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n══ verifier: ${passed} passed, ${failed} failed ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
