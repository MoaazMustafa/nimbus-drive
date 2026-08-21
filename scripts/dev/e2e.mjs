#!/usr/bin/env node
/**
 * End-to-end test of the whole backend, using the mock Google server —
 * no real Google account needed. Boots everything itself on scratch dirs.
 *
 *   npm run test:e2e
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = 'http://127.0.0.1:4477/api';
const ADMIN = 'owner@example.com';
const GUEST = 'guest@example.com';
const STRANGER = 'stranger@example.com';

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

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-e2e-'));
const storage = path.join(tmp, 'storage');
const dataDir = path.join(tmp, 'data');
await fsp.mkdir(storage, { recursive: true });

const env = {
  ...process.env,
  APP_NAME: 'Nimbus E2E',
  BASE_URL: 'http://localhost:3000',
  API_PORT: '4477',
  STORAGE_ROOT: storage,
  DATA_DIR: dataDir,
  ADMIN_EMAIL: ADMIN,
  GOOGLE_CLIENT_ID: 'mock-client',
  GOOGLE_CLIENT_SECRET: 'mock-secret',
  GOOGLE_AUTHORIZE_URL: 'http://127.0.0.1:5599/auth',
  GOOGLE_TOKEN_URL: 'http://127.0.0.1:5599/token',
  GOOGLE_USERINFO_URL: 'http://127.0.0.1:5599/userinfo',
  MOCK_GOOGLE_PORT: '5599',
};

const procs = [];
function boot(name, script) {
  const p = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${name}!] ${d}`));
  procs.push(p);
  return p;
}

boot('mock', path.join(ROOT, 'scripts', 'dev', 'mock-google.mjs'));
boot('api', path.join(ROOT, 'server', 'src', 'index.js'));

async function waitFor(url, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function cookieFrom(res, name) {
  const all = res.headers.getSetCookie?.() ?? [];
  for (const c of all) {
    if (c.startsWith(name + '=')) return c.split(';')[0];
  }
  return null;
}

/** Run the full OAuth dance against the mock and return a session cookie. */
async function login(email) {
  const r1 = await fetch(`${API}/auth/google`, { redirect: 'manual' });
  const authUrl = new URL(r1.headers.get('location'));
  const stateCookie = cookieFrom(r1, 'nimbus_oauth');
  authUrl.searchParams.set('login_hint', email);
  const r2 = await fetch(authUrl, { redirect: 'manual' });
  // In production the callback URL (BASE_URL/api/...) is proxied to the API by
  // the web app; the web app isn't running here, so hit the API directly.
  const cbUrl = r2.headers.get('location').replace('http://localhost:3000/api', API);
  const r3 = await fetch(cbUrl, { redirect: 'manual', headers: { cookie: stateCookie } });
  const sid = cookieFrom(r3, 'nimbus_sid');
  return { sid, finalLocation: r3.headers.get('location') };
}

const j = (sid, extra = {}) => ({ headers: { cookie: sid, 'content-type': 'application/json', ...extra } });
const get = (sid, p) => fetch(`${API}${p}`, { headers: { cookie: sid } });
const post = (sid, p, body) =>
  fetch(`${API}${p}`, { method: 'POST', body: JSON.stringify(body ?? {}), ...j(sid) });
const del = (sid, p) => fetch(`${API}${p}`, { method: 'DELETE', headers: { cookie: sid } });

try {
  console.log('\n— boot');
  check('API server is up', await waitFor(`${API.replace('/api', '')}/api/health`));

  console.log('\n— authentication & authorization');
  const admin = await login(ADMIN);
  check('owner can sign in', !!admin.sid);
  check('owner lands on the drive', admin.finalLocation === 'http://localhost:3000/');

  const stranger = await login(STRANGER);
  check('unknown account is rejected', !stranger.sid);
  check(
    'rejected account is told why',
    (stranger.finalLocation || '').includes('error=not_authorized')
  );

  let r = await fetch(`${API}/fs/list`);
  check('anonymous request is denied (401)', r.status === 401);

  r = await get(admin.sid, '/me');
  const meAdmin = await r.json();
  check('owner /me is admin + can browse', meAdmin.isAdmin === true && meAdmin.canBrowse === true);

  // guest not allowed yet
  const guestPre = await login(GUEST);
  check('guest cannot sign in before allowlisting', !guestPre.sid);

  r = await post(admin.sid, '/admin/allowlist', { email: GUEST, role: 'user' });
  check('admin can allowlist guest', r.ok);

  const guest = await login(GUEST);
  check('guest can sign in after allowlisting', !!guest.sid);

  r = await get(guest.sid, '/fs/list');
  check('guest cannot browse the drive (admin_only visibility)', r.status === 403);
  r = await get(guest.sid, '/admin/overview');
  check('guest cannot open admin APIs', r.status === 403);

  console.log('\n— file operations');
  r = await post(admin.sid, '/fs/mkdir', { dir: '', name: 'Documents' });
  check('mkdir works', r.ok);

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('hello nimbus')], { type: 'text/plain' }), 'hello.txt');
  r = await fetch(`${API}/fs/upload?dir=Documents`, { method: 'POST', body: form, headers: { cookie: admin.sid } });
  const up = await r.json();
  check('upload works', r.ok && up.files?.[0]?.ok, JSON.stringify(up));

  // duplicate name → auto-suffixed, never overwritten
  const form2 = new FormData();
  form2.append('file', new Blob([Buffer.from('second')], { type: 'text/plain' }), 'hello.txt');
  r = await fetch(`${API}/fs/upload?dir=Documents`, { method: 'POST', body: form2, headers: { cookie: admin.sid } });
  const up2 = await r.json();
  check('duplicate upload is auto-renamed', up2.files?.[0]?.name === 'hello (1).txt', JSON.stringify(up2));

  r = await get(admin.sid, '/fs/list?path=Documents');
  const listing = await r.json();
  check('listing shows both files', listing.entries?.length === 2);

  r = await get(admin.sid, '/fs/stream?path=Documents/hello.txt');
  check('stream returns the bytes', (await r.text()) === 'hello nimbus');

  r = await fetch(`${API}/fs/stream?path=${encodeURIComponent('Documents/hello.txt')}`, {
    headers: { cookie: admin.sid, range: 'bytes=0-4' },
  });
  check('range requests work (206)', r.status === 206 && (await r.text()) === 'hello');

  r = await get(admin.sid, '/fs/download?path=Documents');
  check('folder downloads as zip', r.ok && (r.headers.get('content-type') || '').includes('zip'));
  await r.arrayBuffer();

  r = await post(admin.sid, '/fs/rename', { path: 'Documents/hello (1).txt', newName: 'notes.txt' });
  check('rename works', r.ok);

  r = await post(admin.sid, '/fs/mkdir', { dir: '', name: 'Archive' });
  r = await post(admin.sid, '/fs/move', { paths: ['Documents/notes.txt'], destDir: 'Archive' });
  const moved = await r.json();
  check('move works', r.ok && moved.moved?.[0]?.to === 'Archive/notes.txt', JSON.stringify(moved));

  r = await post(admin.sid, '/fs/rename', { path: 'Archive/notes.txt', newName: 'bad<name>.txt' });
  check('cross-platform-illegal names are refused', r.status === 400);
  r = await post(admin.sid, '/fs/rename', { path: 'Archive/notes.txt', newName: 'CON' });
  check('Windows-reserved names are refused', r.status === 400);

  console.log('\n— security');
  r = await get(admin.sid, '/fs/list?path=..%2F..');
  check('path traversal on list is rejected', r.status === 400);
  r = await get(admin.sid, `/fs/stream?path=${encodeURIComponent('../../etc/passwd')}`);
  check('path traversal on stream is rejected', r.status === 400);
  r = await get(admin.sid, `/fs/stream?path=${encodeURIComponent('..\\..\\windows\\system32')}`);
  check('backslash traversal is rejected too', r.status === 400);
  r = await fetch(`${API}/fs/mkdir`, {
    method: 'POST',
    body: JSON.stringify({ dir: '', name: 'evil' }),
    headers: { cookie: admin.sid, 'content-type': 'application/json', origin: 'https://evil.example' },
  });
  check('cross-origin mutation is blocked', r.status === 403);

  console.log('\n— sharing');
  r = await post(admin.sid, '/shares', { path: 'Documents/hello.txt', mode: 'workspace' });
  const wsShare = (await r.json()).share;
  check('workspace share created', !!wsShare?.token);

  r = await get(guest.sid, `/shares/${wsShare.token}/meta`);
  check('guest can open a workspace share', r.ok);
  r = await get(guest.sid, `/shares/${wsShare.token}/download`);
  check('guest can download via share', r.ok && (await r.text()) === 'hello nimbus');
  r = await fetch(`${API}/shares/${wsShare.token}/meta`);
  check('share NEVER opens without sign-in', r.status === 401);

  r = await post(admin.sid, '/shares', { path: 'Archive/notes.txt', mode: 'restricted', emails: [STRANGER] });
  check('restricted share refuses non-allowlisted member', r.status === 400);

  r = await post(admin.sid, '/shares', { path: 'Archive/notes.txt', mode: 'restricted', emails: [GUEST] });
  const rsShare = (await r.json()).share;
  check('restricted share created for guest', !!rsShare?.token);
  r = await get(guest.sid, `/shares/${rsShare.token}/meta`);
  check('member can open restricted share', r.ok);

  // another allowlisted user who is NOT a member
  await post(admin.sid, '/admin/allowlist', { email: 'other@example.com', role: 'user' });
  const other = await login('other@example.com');
  r = await get(other.sid, `/shares/${rsShare.token}/meta`);
  check('non-member cannot open restricted share', r.status === 403);
  r = await get(other.sid, `/shares/${wsShare.token}/meta`);
  check('…but can open the workspace share', r.ok);

  r = await get(guest.sid, '/shares/shared-with-me');
  const swm = await r.json();
  check('shared-with-me lists both for guest', swm.shares?.length === 2, JSON.stringify(swm));

  // folder share + sub navigation + escape attempt
  r = await post(admin.sid, '/shares', { path: 'Documents', mode: 'workspace' });
  const dirShare = (await r.json()).share;
  r = await get(guest.sid, `/shares/${dirShare.token}/list`);
  const dirList = await r.json();
  check('folder share lists contents', Array.isArray(dirList.entries) && dirList.entries.length === 1);
  r = await get(guest.sid, `/shares/${dirShare.token}/stream?sub=${encodeURIComponent('../Archive/notes.txt')}`);
  check('folder share cannot escape its folder', r.status === 400 || r.status === 404);

  // rename keeps shares working
  await post(admin.sid, '/fs/rename', { path: 'Documents', newName: 'Docs' });
  r = await get(guest.sid, `/shares/${dirShare.token}/list`);
  check('share still works after rename', r.ok);
  await post(admin.sid, '/fs/rename', { path: 'Docs', newName: 'Documents' });

  console.log('\n— visibility switch');
  r = await post(admin.sid, '/admin/visibility', { visibility: 'everyone' });
  check('admin can switch visibility', r.ok);
  r = await get(guest.sid, '/fs/list');
  check('guest can browse when visibility=everyone', r.ok);
  await post(admin.sid, '/admin/visibility', { visibility: 'admin_only' });
  r = await get(guest.sid, '/fs/list');
  check('…and is locked out again after switching back', r.status === 403);

  console.log('\n— files pasted into the folder by hand');
  // subscribe to SSE first
  const sseEvents = [];
  const sseAbort = new AbortController();
  const ssePromise = (async () => {
    try {
      const res = await fetch(`${API}/events`, { headers: { cookie: admin.sid }, signal: sseAbort.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(chunk);
          if (m) sseEvents.push(JSON.parse(m[1]));
        }
      }
    } catch {
      /* aborted */
    }
  })();

  await new Promise((r) => setTimeout(r, 400));
  await fsp.writeFile(path.join(storage, 'Documents', 'pasted-by-hand.md'), '# pasted');
  await new Promise((r) => setTimeout(r, 2600)); // watcher awaitWriteFinish + debounce

  r = await get(admin.sid, '/fs/list?path=Documents');
  const l2 = await r.json();
  check(
    'hand-pasted file appears in the listing',
    l2.entries.some((e) => e.name === 'pasted-by-hand.md')
  );
  check(
    'watcher pushed a live SSE event for it',
    sseEvents.some((e) => e.type === 'fs' && e.dirs?.includes('Documents')),
    JSON.stringify(sseEvents)
  );
  sseAbort.abort();
  await ssePromise;

  console.log('\n— delete & trash');
  r = await post(admin.sid, '/fs/delete', { paths: ['Documents/hello.txt'] });
  check('delete works', r.ok);
  const trashFiles = await fsp.readdir(path.join(dataDir, 'trash'));
  check('deleted file is kept in trash', trashFiles.some((f) => f.includes('hello.txt')));
  r = await get(guest.sid, `/shares/${wsShare.token}/meta`);
  check('share dies with the file', r.status === 404);

  console.log('\n— revocation');
  r = await del(admin.sid, `/admin/allowlist/${GUEST}`);
  check('admin can remove guest', r.ok);
  r = await get(guest.sid, '/me');
  check('removed guest is signed out immediately', r.status === 401);

  console.log('\n— guest permissions');
  r = await post(other.sid, '/shares', { path: 'Documents', mode: 'workspace' });
  check('non-browsing user cannot create shares', r.status === 403);
  r = await post(other.sid, '/fs/mkdir', { dir: '', name: 'nope' });
  check('non-browsing user cannot write files', r.status === 403);
} catch (err) {
  failed++;
  fails.push(`unexpected error: ${err.message}`);
  console.error('\nUnexpected error:', err);
} finally {
  for (const p of procs) p.kill();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n══ e2e result: ${passed} passed, ${failed} failed ══`);
if (fails.length) {
  console.log('Failed:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
