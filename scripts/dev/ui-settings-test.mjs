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
};

/** Open the real UI with a stubbed bridge; returns { page, saved } */
async function openUI(browser, config) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(([state, env]) => {
    window.__saved = [];
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
      getConfig: async () => ({ env, configured: true, app: { ...state.app, config: { ...window.__store } } }),
      saveConfig: async (payload) => {
        window.__saved.push(JSON.parse(JSON.stringify(payload)));
        Object.assign(window.__store, payload.app || {});
        return { ok: true, restartNeeded: false, state };
      },
      pickFolder: async () => null,
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

await browser.close();
console.log(`\n══ ui settings: ${passed} passed, ${failed} failed ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
