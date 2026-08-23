#!/usr/bin/env node
/**
 * Renderer settings-persistence tests.
 *
 * The regression that motivated this: Settings saved fine, but main.js's
 * publicState() did not include tunnelMode/tunnelToken in app.config. The form
 * re-reads from that object, so every time the user opened Settings the mode
 * snapped back to "Quick Tunnel" and the token box came up empty — and because
 * Save writes whatever is in the box, saving from that blanked form ERASED the
 * stored token. It looked like "Remote Access settings don't persist".
 *
 * These tests drive the real ui/index.html + ui/app.js in a headless browser
 * with window.nimbus stubbed, so they check what the user actually sees.
 *
 *   node scripts/dev/ui-settings-test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = path.join(ROOT, 'desktop', 'ui', 'index.html');

let passed = 0, failed = 0; const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✘ ${name} ${extra}`); }
};

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  // Skipping locally is fine; skipping in CI would quietly turn this suite into
  // a no-op and the regression could walk straight back in.
  if (process.env.CI) {
    console.log('  ✘ playwright is missing in CI — the renderer tests did not run');
    process.exit(1);
  }
  console.log('  – skipped (playwright not installed; run: npm i --no-save playwright && npx playwright install chromium)');
  process.exit(0);
}

/** Minimal but realistic main-process state. `config` is the part under test. */
const makeState = (config) => ({
  overall: 'stopped', running: false, services: {}, startError: null, external: null, publicOk: null,
  env: { configured: true },
  app: {
    version: '1.0.13', mode: 'bootstrap', repo: 'MoaazMustafa/nimbus-drive',
    defaultRepo: 'MoaazMustafa/nimbus-drive', projectRoot: '/tmp/x', platform: 'win32', packaged: true,
    config,
    localUrl: 'http://localhost:3000', redirectUri: null, tunnelWarning: null,
    install: { busy: false, current: { version: 'v1.0.13', activatedAt: 0 }, previous: null, update: null, needsRebuild: false },
    shellUpdate: { status: 'idle', appOutdated: false, latestVersion: 'v1.0.13', fallback: false, releasesUrl: '#' },
  },
});

const ENV = {
  APP_NAME: 'Nimbus Drive', BASE_URL: 'https://cloud.example.com', STORAGE_ROOT: 'C:\\Files',
  ADMIN_EMAIL: 'a@b.c', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret',
  STORAGE_ROOTS: 'Family Photos=D:\\Photos; Movies=E:\\Media',
};

/** Open the real UI with a stubbed bridge; returns { page, saved } */
async function openUI(browser, config) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(([state, env]) => {
    window.__saved = [];
    window.__calls = [];
    window.__tunnelStatus = {
      installed: true, linked: false, hasConfig: false, ready: false,
      hostname: 'cloud.example.com', tunnels: null, credentials: [], match: null,
    };
    // the store the fake "main process" persists into — mirrors desktop-config.json
    window.__store = { ...state.app.config };
    const noop = () => {};
    window.nimbus = {
      getState: async () => state,
      onState: noop, onLog: noop, onInstall: noop,
      start: async () => state, stop: async () => state, restart: async () => state,
      restartOne: async () => state, takeover: async () => state,
      installFromGitHub: async () => ({ ok: true, state }),
      locateProject: async () => ({ ok: true }),
      cancelInstall: noop,
      checkUpdate: async () => null, runUpdate: async () => ({ ok: true }),
      rollback: async () => ({ ok: true }), rebuild: async () => ({ ok: true }),
      shellUpdateInstall: noop, openReleases: noop, verifyDomain: async () => ({ checks: [] }),

      // tunnel setup bridge
      tunnelStatus: async () => ({ ok: true, status: window.__tunnelStatus }),
      tunnelInstall: async () => { window.__calls.push(['install']); return { ok: true, path: 'cloudflared' }; },
      tunnelSetup: async (opts) => {
        window.__calls.push(['setup', opts]);
        for (const e of (window.__setupSteps || [])) window.__onTunnelStep?.(e);
        return window.__setupResult || { ok: true, result: { hostname: 'cloud.example.com' } };
      },
      tunnelCancel: async () => { window.__calls.push(['cancel']); return { ok: true }; },
      tunnelDelete: async () => ({ ok: true }),
      onTunnelStep: (cb) => { window.__onTunnelStep = cb; },
      getConfig: async () => ({ env, configured: true, app: { ...state.app, config: { ...window.__store } } }),
      saveConfig: async (payload) => {
        window.__saved.push(JSON.parse(JSON.stringify(payload)));
        Object.assign(window.__store, payload.app || {});
        return { ok: true, restartNeeded: false, state };
      },
      pickFolder: async () => window.__pickResult ?? null,
      getLogs: async () => [], exportLogs: async () => null,
      openLink: noop,
    };
  }, [makeState(config), ENV]);
  await page.goto('file://' + UI);
  await page.waitForTimeout(300);
  return { page, errors };
}

/** Click the real Settings tab — that is what triggers loadConfigIntoForm(). */
const openSettings = async (page) => {
  await page.click('.tab[data-tab="settings"]');
  await page.waitForTimeout(200);
};
/** Leave and re-enter Settings, the way a user checking persistence would. */
const reopenSettings = async (page) => {
  await page.click('.tab[data-tab="overview"]');
  await page.waitForTimeout(100);
  await openSettings(page);
};

const browser = await chromium.launch();

console.log('\n— the shape publicState() sends decides what Settings shows');
{
  // FIXED shape: tunnelMode + tunnelToken present
  const { page, errors } = await openUI(browser, {
    tunnelEnabled: true, tunnelMode: 'token', tunnelToken: 'eyJhIjoiYiJ9',
    tunnelName: 'nimbus', cloudflaredPath: 'cloudflared', startServicesOnLaunch: true, openAtLogin: false,
  });
  check('the panel loads without a page error', errors.length === 0, errors[0] || '');
  await openSettings(page);

  const mode = await page.$eval('#f-tunnelMode', (el) => el.value);
  const token = await page.$eval('#f-tunnelToken', (el) => el.value);
  const enabled = await page.$eval('#f-tunnelEnabled', (el) => el.checked);
  check('saved mode "token" survives into the form', mode === 'token', `got ${mode}`);
  check('saved token survives into the form', token === 'eyJhIjoiYiJ9', `got "${token}"`);
  check('tunnel stays enabled', enabled === true);

  const tokenVisible = await page.$eval('#group-tunnelToken', (el) => !el.classList.contains('hidden'));
  check('the token field is revealed for token mode', tokenVisible);

  // Save without touching anything must not destroy the token
  await page.click('#btn-save');
  await page.waitForTimeout(200);
  const saved = await page.evaluate(() => window.__saved.at(-1));
  check('an untouched Save keeps the token', saved?.app?.tunnelToken === 'eyJhIjoiYiJ9', JSON.stringify(saved?.app));
  check('an untouched Save keeps the mode', saved?.app?.tunnelMode === 'token', JSON.stringify(saved?.app));

  // Reopen: the values must still be there
  await reopenSettings(page);
  const mode2 = await page.$eval('#f-tunnelMode', (el) => el.value);
  const token2 = await page.$eval('#f-tunnelToken', (el) => el.value);
  check('reopening Settings still shows the mode', mode2 === 'token', `got ${mode2}`);
  check('reopening Settings still shows the token', token2 === 'eyJhIjoiYiJ9', `got "${token2}"`);
  await page.close();
}

console.log('\n— and the old shape reproduces the bug (guards the fix)');
{
  // BROKEN shape: exactly what publicState() used to send
  const { page } = await openUI(browser, {
    tunnelEnabled: true, tunnelName: 'nimbus', cloudflaredPath: 'cloudflared',
    startServicesOnLaunch: true, openAtLogin: false,
  });
  await openSettings(page);
  const mode = await page.$eval('#f-tunnelMode', (el) => el.value);
  const token = await page.$eval('#f-tunnelToken', (el) => el.value);
  check('without tunnelMode the form silently resets to "quick"', mode === 'quick', `got ${mode}`);
  check('without tunnelToken the token box comes up empty', token === '', `got "${token}"`);

  await page.click('#btn-save');
  await page.waitForTimeout(200);
  const saved = await page.evaluate(() => window.__saved.at(-1));
  check('...and saving from that form would have wiped the stored token', saved?.app?.tunnelToken === '', JSON.stringify(saved?.app));
  await page.close();
}


console.log('\n— the in-app tunnel setup panel');
{
  const { page, errors } = await openUI(browser, {
    tunnelEnabled: true, tunnelMode: 'named', tunnelToken: '',
    tunnelName: 'nimbus', cloudflaredPath: 'cloudflared', startServicesOnLaunch: true, openAtLogin: false,
  });
  check('the panel loads without a page error', errors.length === 0, errors[0] || '');
  await openSettings(page);

  const visible = await page.$eval('#tunnel-setup', (el) => !el.classList.contains('hidden'));
  check('the setup panel shows for named mode', visible);

  await page.waitForTimeout(200);
  const pill = await page.$eval('#tunnel-state', (el) => el.textContent.trim());
  check('an unlinked account reads "not signed in"', pill === 'not signed in', pill);
  const hint = await page.$eval('#tunnel-hint', (el) => el.textContent);
  check('the hint names the domain it will route', hint.includes('cloud.example.com'), hint);

  // the case that strands people: tunnel exists remotely, credentials do not
  await page.evaluate(() => {
    window.__tunnelStatus = {
      installed: true, linked: true, hasConfig: false, ready: false, hostname: 'cloud.example.com',
      tunnels: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'nimbus', connections: 0 }],
      credentials: [], match: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'nimbus' },
    };
  });
  await page.click('#btn-tunnel-refresh');
  await page.waitForTimeout(200);
  const hint2 = await page.$eval('#tunnel-hint', (el) => el.textContent);
  check('a tunnel with no local credentials is called out', /credentials are not on this PC/.test(hint2), hint2);
  check('...and points at the recreate option', /Recreate the tunnel on this PC/.test(hint2), hint2);

  // run the setup and watch the steps render
  await page.evaluate(() => {
    window.__setupSteps = [
      { step: 'link', status: 'running', detail: 'Opening Cloudflare in your browser…' },
      { step: 'link', status: 'ok', detail: 'Cloudflare account linked.' },
      { step: 'tunnel', status: 'ok', detail: 'Created the tunnel "nimbus".' },
      { step: 'dns', status: 'ok', detail: 'cloud.example.com now points at the tunnel.' },
      { step: 'config', status: 'ok', detail: 'Configuration written.' },
    ];
  });
  await page.check('#f-tunnelOverwriteDns');
  await page.click('#btn-tunnel-setup');
  await page.waitForTimeout(300);

  const call = await page.evaluate(() => window.__calls.find((c) => c[0] === 'setup'));
  check('setup is invoked', !!call);
  check('...and carries the "replace DNS record" choice', call?.[1]?.overwriteDns === true, JSON.stringify(call?.[1]));
  check('...and the recreate choice', call?.[1]?.recreate === false, JSON.stringify(call?.[1]));

  const stepText = await page.$eval('#tunnel-steps', (el) => el.textContent);
  check('every step is shown to the user', ['Authorize your Cloudflare account', 'Create the tunnel', 'Point your domain at it', 'Write the tunnel configuration'].every((t) => stepText.includes(t)), stepText);
  check('a repeated step updates in place rather than duplicating', (stepText.match(/Authorize your Cloudflare account/g) || []).length === 1, stepText);
  check('the final state of a step wins', stepText.includes('Cloudflare account linked.'), stepText);

  const mode = await page.$eval('#f-tunnelMode', (el) => el.value);
  check('a successful setup leaves the app in named mode', mode === 'named', mode);
  await page.close();
}


console.log('\n— attaching more folders and drives');
{
  const { page, errors } = await openUI(browser, {
    tunnelEnabled: false, tunnelMode: 'named', tunnelToken: '',
    tunnelName: 'nimbus', cloudflaredPath: 'cloudflared', startServicesOnLaunch: true, openAtLogin: false,
  });
  check('the panel loads without a page error', errors.length === 0, errors[0] || '');
  await openSettings(page);

  const rows = await page.$$eval('#roots-list li', (els) => els.map((el) => ({
    name: el.querySelector('input')?.value ?? null,
    path: el.querySelector('.why')?.textContent ?? '',
  })));
  check('saved folders are listed', rows.length === 2, JSON.stringify(rows));
  check('...with their names', rows.map((r) => r.name).join(', ') === 'Family Photos, Movies', JSON.stringify(rows));
  check('...and their paths', rows[1].path === 'E:\\Media', rows[1].path);

  // add one through the folder picker
  await page.evaluate(() => { window.__pickResult = 'F:\\Backup'; });
  await page.click('#btn-root-add');
  await page.waitForTimeout(150);
  const after = await page.$$eval('#roots-list li input', (els) => els.map((e) => e.value));
  check('picking a folder adds it', after.length === 3, JSON.stringify(after));
  check('...named after the folder itself', after[2] === 'Backup', after[2]);

  // adding the same folder twice must not duplicate it
  await page.click('#btn-root-add');
  await page.waitForTimeout(150);
  check('the same folder cannot be added twice', (await page.$$eval('#roots-list li input', (e) => e.length)) === 3);

  // rename, remove, save
  await page.fill('#roots-list li:nth-child(1) input', 'Photos');
  await page.click('#roots-list li:nth-child(2) button');
  await page.waitForTimeout(150);
  check('removing a row drops it', (await page.$$eval('#roots-list li input', (e) => e.length)) === 2);

  await page.click('#btn-save');
  await page.waitForTimeout(250);
  const saved = await page.evaluate(() => window.__saved.at(-1));
  check('the folder list is saved back to STORAGE_ROOTS',
    saved?.env?.STORAGE_ROOTS === 'Photos=D:\\Photos; Backup=F:\\Backup', JSON.stringify(saved?.env?.STORAGE_ROOTS));
  check('...in the "Name=Path;" form the server reads', /=.+;/.test(saved?.env?.STORAGE_ROOTS || ''), saved?.env?.STORAGE_ROOTS);

  // an empty list must clear the setting, not leave the old value behind
  await reopenSettings(page);
  for (let guard = 0; guard < 6; guard += 1) {
    const left = await page.$$eval('#roots-list li button', (els) => els.length);
    if (!left) break;
    await page.click('#roots-list li button');
    await page.waitForTimeout(120);
  }
  check('every folder can be removed', (await page.$$eval('#roots-list li button', (e) => e.length)) === 0);
  check('...and the empty state explains itself', /No extra folders yet/.test(await page.$eval('#roots-list', (el) => el.textContent)), await page.$eval('#roots-list', (el) => el.textContent));
  await page.click('#btn-save');
  await page.waitForTimeout(250);
  const cleared = await page.evaluate(() => window.__saved.at(-1));
  check('removing every folder clears the setting', cleared?.env?.STORAGE_ROOTS === '', JSON.stringify(cleared?.env?.STORAGE_ROOTS));
  await page.close();
}

await browser.close();
console.log(`\n══ ui settings: ${passed} passed, ${failed} failed ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
