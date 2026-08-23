#!/usr/bin/env node
/**
 * Several attached folders (drives) instead of one.
 *
 * The drive used to be a single STORAGE_ROOT. Now extra folders are declared in
 * STORAGE_ROOTS and each becomes a named library addressed as "<id>/<path>".
 * The rule that makes this safe to ship onto a running drive: a path with NO
 * library prefix still resolves against the first folder, so every public link,
 * trash entry and bookmark made before this feature keeps pointing at the same
 * file.
 *
 *   node scripts/dev/libraries-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = 'http://127.0.0.1:4478/api';
const ADMIN = 'owner@example.com';

let passed = 0, failed = 0; const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✘ ${name} ${extra}`); }
};

const lib = await import(path.join(ROOT, 'server', 'src', 'libraries.js'));

console.log('\n— reading the folder list a person typed');
{
  const one = lib.parseRootsSpec('Photos=D:\\Photos; Documents=E:\\Docs');
  check('name=path pairs are read in order', JSON.stringify(one) === JSON.stringify([
    { name: 'Photos', path: 'D:\\Photos' }, { name: 'Documents', path: 'E:\\Docs' }]), JSON.stringify(one));
  const bare = lib.parseRootsSpec('D:\\Photos;E:\\Docs');
  check('a bare path needs no name', bare.length === 2 && bare[0].path === 'D:\\Photos' && bare[0].name === '');
  check('a drive letter survives the name/path split', lib.parseRootsSpec('Media=D:\\')[0].path === 'D:\\');
  const json = lib.parseRootsSpec('[{"name":"Photos","path":"/mnt/p"}]');
  check('a JSON array works too', json.length === 1 && json[0].name === 'Photos');
  const obj = lib.parseRootsSpec('{"Photos":"/mnt/p","Docs":"/mnt/d"}');
  check('so does a JSON object', obj.length === 2 && obj[1].path === '/mnt/d');
  check('newlines separate entries as well as semicolons', lib.parseRootsSpec('A=/a\nB=/b').length === 2);
  check('an empty setting means no extra folders', lib.parseRootsSpec('').length === 0);
  check('stray separators are ignored', lib.parseRootsSpec(';;A=/a;;').length === 1);
  check('malformed JSON falls back to the plain form', lib.parseRootsSpec('[not json').length === 1);
}

console.log('\n— naming and identifying folders');
{
  check('a folder is named after itself', lib.nameForPath('/mnt/Family Photos') === 'Family Photos');
  check('a bare drive letter gets a readable name', lib.nameForPath('D:') === 'D drive');
  check('trailing separators do not confuse it', lib.nameForPath('/mnt/Docs/') === 'Docs');
  check('names become url-safe ids', lib.slugify('My Photos (2026)') === 'my-photos-2026');
  check('an unusable name still yields an id', lib.slugify('###') === 'folder');
  check('accents are folded, not dropped', lib.slugify('Álbum') === 'album');

  const { libraries, problems } = lib.buildLibraries({
    defaultRoot: '/srv/main', defaultName: 'My Drive',
    spec: 'Photos=/mnt/photos;Photos=/mnt/other;/srv/main',
    resolve: (p) => p,
  });
  check('the default folder is always first', libraries[0].id === 'my-drive' && libraries[0].isDefault === true);
  check('a repeated name gets a distinct id', libraries.map((l) => l.id).join(',') === 'my-drive,photos,photos-2', libraries.map((l) => l.id).join(','));
  check('the same folder attached twice is dropped', libraries.length === 3, String(libraries.length));
  check('...and the owner is told why', problems.some((p) => /more than once/.test(p)), JSON.stringify(problems));
}

console.log('\n— addressing a path inside a folder');
{
  const libs = [{ id: 'my-drive', name: 'My Drive', root: '/srv/main' }, { id: 'photos', name: 'Photos', root: '/mnt/photos' }];
  const a = lib.splitLibraryPath('photos/2026/x.jpg', libs);
  check('a prefixed path selects its folder', a.library.id === 'photos' && a.sub.join('/') === '2026/x.jpg');
  const b = lib.splitLibraryPath('2026/x.jpg', libs);
  check('an UNPREFIXED path still means the first folder', b.library.id === 'my-drive' && b.prefixed === false);
  check('...which is what keeps old links alive', b.sub.join('/') === '2026/x.jpg');
  check('the canonical form is always prefixed', lib.canonicalPath(libs[1], ['a', 'b']) === 'photos/a/b');
  check('a folder root canonicalises to just its id', lib.canonicalPath(libs[1], []) === 'photos');
}

// ── live server with two folders attached ───────────────────────────
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nimbus-libs-'));
const main = path.join(tmp, 'main');
const photos = path.join(tmp, 'photos');
const dataDir = path.join(tmp, 'data');
await fsp.mkdir(main, { recursive: true });
await fsp.mkdir(photos, { recursive: true });
await fsp.writeFile(path.join(main, 'legacy.txt'), 'made before libraries existed');
await fsp.writeFile(path.join(photos, 'holiday.jpg'), 'not really a jpeg');

const env = {
  ...process.env,
  APP_NAME: 'Nimbus Libraries', BASE_URL: 'http://localhost:3000', API_PORT: '4478',
  STORAGE_ROOT: main, STORAGE_ROOT_NAME: 'My Drive',
  STORAGE_ROOTS: `Photos=${photos}`,
  DATA_DIR: dataDir, ADMIN_EMAIL: ADMIN,
  GOOGLE_CLIENT_ID: 'mock-client', GOOGLE_CLIENT_SECRET: 'mock-secret',
  GOOGLE_AUTHORIZE_URL: 'http://127.0.0.1:5600/auth',
  GOOGLE_TOKEN_URL: 'http://127.0.0.1:5600/token',
  GOOGLE_USERINFO_URL: 'http://127.0.0.1:5600/userinfo',
  MOCK_GOOGLE_PORT: '5600',
};
const procs = [];
const boot = (name, script) => {
  const p = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.LIB_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${name}!] ${d}`));
  procs.push(p);
};
boot('mock', path.join(ROOT, 'scripts', 'dev', 'mock-google.mjs'));
boot('api', path.join(ROOT, 'server', 'src', 'index.js'));

const waitFor = async (url, ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if ((await fetch(url)).ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};
const cookieFrom = (res, name) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(name + '='))?.split(';')[0] || null;
async function login(email) {
  const r1 = await fetch(`${API}/auth/google`, { redirect: 'manual' });
  const authUrl = new URL(r1.headers.get('location'));
  const stateCookie = cookieFrom(r1, 'nimbus_oauth');
  authUrl.searchParams.set('login_hint', email);
  const r2 = await fetch(authUrl, { redirect: 'manual' });
  const cb = r2.headers.get('location').replace('http://localhost:3000/api', API);
  return cookieFrom(await fetch(cb, { redirect: 'manual', headers: { cookie: stateCookie } }), 'nimbus_sid');
}
const get = (sid, p) => fetch(`${API}${p}`, { headers: { cookie: sid } });
const upload = (sid, dir, filename, content) => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(content)]), filename);
  return fetch(`${API}/fs/upload?dir=${encodeURIComponent(dir)}`, { method: 'POST', body: form, headers: { cookie: sid } });
};

try {
  console.log('\n— a drive with two folders attached');
  check('the API starts with both folders', await waitFor(`${API}/health`));
  const sid = await login(ADMIN);
  check('the owner can sign in', !!sid);

  const libs = await (await get(sid, '/fs/libraries')).json();
  check('both folders are reported', libs.libraries?.length === 2, JSON.stringify(libs));
  check('...with their names', libs.libraries.map((l) => l.name).join(', ') === 'My Drive, Photos', JSON.stringify(libs.libraries.map((l) => l.name)));
  check('...and stable ids', libs.libraries.map((l) => l.id).join(',') === 'my-drive,photos');
  check('...and the drive says it is in multi-folder mode', libs.multi === true);
  check('...and each reports whether it is plugged in', libs.libraries.every((l) => l.available === true));

  const root = await (await get(sid, '/fs/list?path=')).json();
  check('the top level lists the folders, not files', root.entries.length === 2 && root.entries.every((e) => e.isDir));
  check('...shown by name', root.entries.map((e) => e.name).join(', ') === 'My Drive, Photos');
  check('...addressed by id', root.entries.map((e) => e.path).join(',') === 'my-drive,photos');
  check('...and carrying their library details for the sidebar', root.entries[1].library?.id === 'photos');

  const inPhotos = await (await get(sid, '/fs/list?path=photos')).json();
  check('a folder lists its own contents', inPhotos.entries.some((e) => e.name === 'holiday.jpg'), JSON.stringify(inPhotos.entries));
  check('...with prefixed paths', inPhotos.entries[0].path === 'photos/holiday.jpg', inPhotos.entries[0]?.path);

  const inMain = await (await get(sid, '/fs/list?path=my-drive')).json();
  check('the default folder lists its own contents', inMain.entries.some((e) => e.name === 'legacy.txt'));

  console.log('\n— paths made before this feature still work');
  const legacyStat = await get(sid, '/fs/stat?path=legacy.txt');
  check('an unprefixed path still resolves', legacyStat.status === 200, String(legacyStat.status));
  const legacyBody = await legacyStat.json();
  check('...and comes back in the new canonical form', legacyBody.path === 'my-drive/legacy.txt', JSON.stringify(legacyBody.path));
  const legacyGet = await get(sid, '/fs/download?path=legacy.txt');
  check('...and still downloads the same bytes', (await legacyGet.text()) === 'made before libraries existed');

  console.log('\n— writing lands in the folder you chose');
  const up = await upload(sid, 'photos', 'newshot.txt', 'from the camera');
  check('an upload into a named folder succeeds', up.status === 200, String(up.status));
  check('...and the file is on THAT disk', fs.existsSync(path.join(photos, 'newshot.txt')));
  check('...and not on the other one', !fs.existsSync(path.join(main, 'newshot.txt')));

  const upRoot = await upload(sid, '', 'stray.txt', 'nowhere');
  check('uploading to the top level is refused', upRoot.status === 400, String(upRoot.status));
  check('...with an explanation, not a stack trace', /attached folders/i.test(await upRoot.text()));

  console.log('\n— escaping a folder is still impossible');
  for (const bad of ['photos/../../etc/passwd', 'photos/../main/legacy.txt', '../outside.txt']) {
    const r = await get(sid, `/fs/stat?path=${encodeURIComponent(bad)}`);
    check(`"${bad}" is rejected or contained`, r.status === 400 || r.status === 404, String(r.status));
  }

  console.log('\n— search covers every attached folder');
  const found = await (await get(sid, '/fs/search?q=txt')).json();
  const paths = (found.results || []).map((r) => r.path);
  check('files from the default folder are found', paths.some((p) => p.startsWith('my-drive/')), JSON.stringify(paths));
  check('files from the second folder are found', paths.some((p) => p.startsWith('photos/')), JSON.stringify(paths));
  check('every result is addressable', paths.every((p) => p.includes('/')), JSON.stringify(paths));
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n══ libraries: ${passed} passed, ${failed} failed ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
