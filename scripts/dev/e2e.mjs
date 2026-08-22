#!/usr/bin/env node
/**
 * End-to-end test of the whole backend, using the mock Google server —
 * no real Google account needed. Boots everything itself on scratch dirs.
 *
 *   npm run test:e2e
 *
 * Covers: auth + allowlist, full-access model, file ops, folder upload,
 * bulk zip, public links (no-login), trash restore/purge, activity log,
 * and the fixed bugs (LIKE-wildcard, upload race, empty-file range, LAN origin).
 */
import { spawn } from 'node:child_process';
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

async function login(email) {
  const r1 = await fetch(`${API}/auth/google`, { redirect: 'manual' });
  const authUrl = new URL(r1.headers.get('location'));
  const stateCookie = cookieFrom(r1, 'nimbus_oauth');
  authUrl.searchParams.set('login_hint', email);
  const r2 = await fetch(authUrl, { redirect: 'manual' });
  const cbUrl = r2.headers.get('location').replace('http://localhost:3000/api', API);
  const r3 = await fetch(cbUrl, { redirect: 'manual', headers: { cookie: stateCookie } });
  const sid = cookieFrom(r3, 'nimbus_sid');
  return { sid, finalLocation: r3.headers.get('location') };
}

const j = (sid, extra = {}) => ({ headers: { cookie: sid, 'content-type': 'application/json', ...extra } });
const get = (sid, p, extra = {}) => fetch(`${API}${p}`, { headers: { cookie: sid, ...extra } });
const post = (sid, p, body, extra = {}) =>
  fetch(`${API}${p}`, { method: 'POST', body: JSON.stringify(body ?? {}), ...j(sid, extra) });
const del = (sid, p) => fetch(`${API}${p}`, { method: 'DELETE', headers: { cookie: sid } });
const upload = (sid, dir, filename, content, extraQuery = '') => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(content)]), filename);
  return fetch(`${API}/fs/upload?dir=${encodeURIComponent(dir)}${extraQuery}`, {
    method: 'POST',
    body: form,
    headers: { cookie: sid },
  });
};

try {
  console.log('\n— boot');
  check('API server is up', await waitFor(`${API.replace('/api', '')}/api/health`));

  console.log('\n— authentication & authorization');
  const admin = await login(ADMIN);
  check('owner can sign in', !!admin.sid);
  check('owner lands on the drive', admin.finalLocation === 'http://localhost:3000/');

  const stranger = await login(STRANGER);
  check('unknown account is rejected', !stranger.sid);
  check('rejected account is told why', (stranger.finalLocation || '').includes('error=not_authorized'));

  let r = await fetch(`${API}/fs/list`);
  check('anonymous request is denied (401)', r.status === 401);

  r = await get(admin.sid, '/me');
  const meAdmin = await r.json();
  check('owner /me is admin + can browse', meAdmin.isAdmin === true && meAdmin.canBrowse === true);

  const guestPre = await login(GUEST);
  check('guest cannot sign in before allowlisting', !guestPre.sid);

  r = await post(admin.sid, '/admin/allowlist', { email: GUEST, role: 'user' });
  check('admin can allowlist guest', r.ok);

  const guest = await login(GUEST);
  check('guest can sign in after allowlisting', !!guest.sid);

  console.log('\n— every allowlisted user has FULL access (family model)');
  r = await get(guest.sid, '/fs/list');
  check('family member can browse the whole drive', r.ok);
  r = await post(guest.sid, '/fs/mkdir', { dir: '', name: 'FamilyFolder' });
  check('family member can create folders', r.ok);
  r = await get(guest.sid, '/admin/overview');
  check('family member cannot open admin APIs', r.status === 403);

  console.log('\n— file operations');
  r = await post(admin.sid, '/fs/mkdir', { dir: '', name: 'Documents' });
  check('mkdir works', r.ok);

  r = await upload(admin.sid, 'Documents', 'hello.txt', 'hello nimbus');
  const up = await r.json();
  check('upload works', r.ok && up.files?.[0]?.ok, JSON.stringify(up));

  r = await upload(admin.sid, 'Documents', 'hello.txt', 'second');
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

  console.log('\n— folder upload (recreates structure)');
  r = await upload(admin.sid, '', 'a.txt', 'A', '&rel=Photos/2024');
  const uf = await r.json();
  check('folder upload created nested path', r.ok && uf.files?.[0]?.path === 'Photos/2024/a.txt', JSON.stringify(uf));
  r = await get(admin.sid, '/fs/list?path=Photos/2024');
  check('nested file is listed', (await r.json()).entries?.some((e) => e.name === 'a.txt'));

  console.log('\n— bulk zip download');
  r = await fetch(`${API}/fs/zip`, {
    method: 'POST',
    headers: { cookie: admin.sid, 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['Documents', 'Photos'] }),
  });
  check('bulk zip streams a zip', r.ok && (r.headers.get('content-type') || '').includes('zip'));
  await r.arrayBuffer();

  console.log('\n— empty file (0-byte) opens fine [regression]');
  await fsp.writeFile(path.join(storage, 'empty.bin'), '');
  await new Promise((res) => setTimeout(res, 100));
  r = await fetch(`${API}/fs/stream?path=empty.bin`, { headers: { cookie: admin.sid, range: 'bytes=0-' } });
  check('0-byte file with a range header returns 200 (not 416)', r.status === 200);

  console.log('\n— concurrent same-name uploads keep every file [regression]');
  await post(admin.sid, '/fs/mkdir', { dir: '', name: 'race' });
  await Promise.all(['A', 'B', 'C', 'D', 'E'].map((c) => upload(admin.sid, 'race', 'same.txt', c.repeat(50))));
  const raceList = await (await get(admin.sid, '/fs/list?path=race')).json();
  check('5 concurrent same-name uploads keep all 5', raceList.entries.length === 5, `kept ${raceList.entries.length}`);

  console.log('\n— rename & move keep links, LIKE-safe [regression]');
  r = await post(admin.sid, '/fs/rename', { path: 'Documents/hello (1).txt', newName: 'notes.txt' });
  check('rename works', r.ok);
  await post(admin.sid, '/fs/mkdir', { dir: '', name: 'Archive' });
  r = await post(admin.sid, '/fs/move', { paths: ['Documents/notes.txt'], destDir: 'Archive' });
  check('move works', r.ok && (await r.json()).moved?.[0]?.to === 'Archive/notes.txt');

  // LIKE-wildcard regression: a link on axb/f is untouched by deleting a_b
  await post(admin.sid, '/fs/mkdir', { dir: '', name: 'a_b' });
  await post(admin.sid, '/fs/mkdir', { dir: '', name: 'axb' });
  await upload(admin.sid, 'axb', 'f.txt', 'keep');
  r = await post(admin.sid, '/links', { path: 'axb/f.txt' });
  const likeTok = (await r.json()).link?.token;
  await post(admin.sid, '/fs/delete', { paths: ['a_b'] });
  r = await fetch(`${API}/public/links/${likeTok}/meta`);
  check('deleting "a_b" does NOT kill the link on "axb/f.txt"', r.ok, `status=${r.status}`);

  console.log('\n— cross-platform-illegal names still refused');
  r = await post(admin.sid, '/fs/rename', { path: 'Archive/notes.txt', newName: 'bad<name>.txt' });
  check('illegal names refused', r.status === 400);
  r = await post(admin.sid, '/fs/rename', { path: 'Archive/notes.txt', newName: 'CON' });
  check('Windows-reserved names refused', r.status === 400);

  console.log('\n— security');
  r = await get(admin.sid, '/fs/list?path=..%2F..');
  check('path traversal on list is rejected', r.status === 400);
  r = await get(admin.sid, `/fs/stream?path=${encodeURIComponent('../../etc/passwd')}`);
  check('path traversal on stream is rejected', r.status === 400);
  r = await fetch(`${API}/fs/mkdir`, {
    method: 'POST',
    body: JSON.stringify({ dir: '', name: 'evil' }),
    headers: { cookie: admin.sid, 'content-type': 'application/json', origin: 'https://evil.example' },
  });
  check('cross-origin mutation is blocked', r.status === 403);
  // LAN-origin regression: reached by the LAN IP, proxied to the API — the
  // browser's host arrives as X-Forwarded-Host and must be accepted.
  r = await fetch(`${API}/fs/mkdir`, {
    method: 'POST',
    body: JSON.stringify({ dir: '', name: 'lanok' }),
    headers: {
      cookie: admin.sid,
      'content-type': 'application/json',
      origin: 'http://192.168.1.50:3000',
      'x-forwarded-host': '192.168.1.50:3000',
    },
  });
  check('LAN access via proxied X-Forwarded-Host is allowed', r.ok, `status=${r.status}`);

  console.log('\n— public links (no login required)');
  r = await post(admin.sid, '/links', { path: 'Archive/notes.txt' });
  const link = (await r.json()).link;
  check('link created', !!link?.token);
  check('link url points at /l/', (link?.url || '').includes('/l/'));

  r = await fetch(`${API}/public/links/${link.token}/meta`);
  check('GUEST (no login) can open a public link', r.ok, `status=${r.status}`);
  r = await fetch(`${API}/public/links/${link.token}/download`);
  check('guest (no login) can download via public link', r.ok && (await r.text()) === 'second');

  r = await fetch(`${API}/public/links/nonexistent/meta`);
  check('bad token is 404', r.status === 404);

  // folder link + escape attempt
  r = await post(admin.sid, '/links', { path: 'Documents' });
  const dirLink = (await r.json()).link;
  r = await fetch(`${API}/public/links/${dirLink.token}/list`);
  const dl = await r.json();
  check('folder link lists contents (no login)', Array.isArray(dl.entries));
  r = await fetch(`${API}/public/links/${dirLink.token}/stream?sub=${encodeURIComponent('../Archive/notes.txt')}`);
  check('folder link cannot escape its folder', r.status === 400 || r.status === 404);

  // expiry validation regression (used to 500)
  r = await post(admin.sid, '/links', { path: 'Archive/notes.txt', expiresDays: -5 });
  check('negative expiry is a clean 400 (not a 500)', r.status === 400, `status=${r.status}`);
  r = await post(admin.sid, '/links', { path: 'Archive/notes.txt', expiresDays: 'abc' });
  check('non-numeric expiry is a clean 400', r.status === 400, `status=${r.status}`);

  // deleting the file kills its links
  await post(admin.sid, '/fs/delete', { paths: ['Archive/notes.txt'] });
  r = await fetch(`${API}/public/links/${link.token}/meta`);
  check('link dies with the file', r.status === 404);

  console.log('\n— trash: list / restore / purge');
  r = await get(admin.sid, '/fs/trash');
  const trash1 = await r.json();
  check('trash lists deleted items', trash1.items?.some((t) => t.name === 'notes.txt'), JSON.stringify(trash1.items?.map((t) => t.name)));
  const trashRow = trash1.items.find((t) => t.name === 'notes.txt');
  r = await post(admin.sid, '/fs/trash/restore', { ids: [trashRow.id] });
  const restored = await r.json();
  check('restore returns the item to its original folder', r.ok && restored.restored?.[0] === 'Archive/notes.txt', JSON.stringify(restored));
  r = await get(admin.sid, '/fs/list?path=Archive');
  check('restored file is back on the drive', (await r.json()).entries?.some((e) => e.name === 'notes.txt'));

  // purge
  await post(admin.sid, '/fs/delete', { paths: ['Archive/notes.txt'] });
  const t2 = await (await get(admin.sid, '/fs/trash')).json();
  const rowToPurge = t2.items.find((t) => t.name === 'notes.txt');
  r = await post(admin.sid, '/fs/trash/delete', { ids: [rowToPurge.id] });
  check('permanent delete from trash works', r.ok);
  const t3 = await (await get(admin.sid, '/fs/trash')).json();
  check('purged item is gone from trash', !t3.items.some((t) => t.id === rowToPurge.id));

  console.log('\n— live watcher (hand-pasted files)');
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
  await new Promise((res) => setTimeout(res, 400));
  await fsp.writeFile(path.join(storage, 'Documents', 'pasted.md'), '# pasted');
  await new Promise((res) => setTimeout(res, 2600));
  const l2 = await (await get(admin.sid, '/fs/list?path=Documents')).json();
  check('hand-pasted file appears in the listing', l2.entries.some((e) => e.name === 'pasted.md'));
  check('watcher pushed a live SSE event', sseEvents.some((e) => e.type === 'fs' && e.dirs?.includes('Documents')));
  sseAbort.abort();
  await ssePromise;

  console.log('\n— admin activity log');
  r = await get(admin.sid, '/admin/activity?limit=200');
  const act = await r.json();
  const actions = new Set((act.activity || []).map((a) => a.action));
  check('activity records logins', actions.has('login'));
  check('activity records uploads', actions.has('upload'));
  check('activity records downloads', actions.has('download'));
  check('activity records deletes', actions.has('delete'));
  check('activity records public link opens', actions.has('link_open'));
  check(
    'activity can be filtered by user',
    (await (await get(admin.sid, `/admin/activity?email=${encodeURIComponent(GUEST)}`)).json()).activity.every((a) => a.email === GUEST)
  );
  r = await get(guest.sid, '/admin/activity');
  check('family member cannot read the activity log', r.status === 403);

  console.log('\n— revocation');
  r = await del(admin.sid, `/admin/allowlist/${GUEST}`);
  check('admin can remove a family member', r.ok);
  r = await get(guest.sid, '/me');
  check('removed member is signed out immediately', r.status === 401);
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
