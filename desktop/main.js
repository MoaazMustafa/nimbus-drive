'use strict';
/**
 * Nimbus Drive Desktop — Electron main process.
 *
 * Two ways to get a running drive, one control panel:
 *  - BOOTSTRAP mode (new PCs): the app downloads the code from GitHub,
 *    installs a private Node runtime + dependencies, builds, and runs it.
 *    Updates come from GitHub Releases, with one-click rollback.
 *  - CHECKOUT mode (developer machines): point the app at an existing
 *    nimbus-drive folder and it supervises that.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  Notification,
  nativeImage,
} = require('electron');
const { Supervisor } = require('./lib/supervisor');
const { readEnv, updateEnv, createEnv, validateEnvValues, redirectUri } = require('./lib/env');
const { Bootstrap } = require('./lib/bootstrap');
const { GitHub, parseRepo } = require('./lib/github');
const { ensureNode, ensureCloudflared } = require('./lib/runtime');
const { runDiagnostics } = require('./lib/verify');
const cfTunnel = require('./lib/cftunnel');
const { hostnameFromBaseUrl } = require('./lib/cfconfig');
const { isNewerVersion } = require('./lib/version');

// The home of this app: where installs and updates come from. Baked in so a
// new user never has to know or type it — Setup.exe → Install → done.
const DEFAULT_REPO = 'MoaazMustafa/nimbus-drive';
const startHidden = process.argv.includes('--hidden') || process.argv.includes('--autostart');

// ── app config (lives in the OS per-user app-data dir) ──────────────
const CONFIG_DEFAULTS = {
  mode: null, // 'bootstrap' | 'checkout'
  repo: '', // "owner/repo" (bootstrap mode)
  projectRoot: null, // checkout mode
  nodePath: 'node',
  tunnelEnabled: false,
  tunnelMode: 'named', // 'named' | 'token' | 'quick' — named preserves existing tunnel setups; quick URLs change every restart and break Google OAuth
  tunnelName: 'nimbus',
  tunnelToken: '',
  cloudflaredPath: 'cloudflared',
  startServicesOnLaunch: true,
};
let configPath;
let appConfig = { ...CONFIG_DEFAULTS };

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'desktop-config.json');
  try {
    appConfig = { ...CONFIG_DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    appConfig = { ...CONFIG_DEFAULTS };
  }
}
function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(appConfig, null, 2));
  } catch { /* best-effort */ }
}

function configureWindowsStartup(enable) {
  if (process.platform !== 'win32') return;
  const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbsPath = path.join(startupDir, 'NimbusDriveAutoStart.vbs');
  if (enable) {
    try {
      const exePath = app.getPath('exe');
      const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """" & "${exePath.replace(/\\/g, '\\\\')}" & """ --hidden --autostart", 0, False\r\n`;
      fs.mkdirSync(startupDir, { recursive: true });
      fs.writeFileSync(vbsPath, vbsContent, 'utf8');
    } catch { /* best-effort */ }
  } else {
    try {
      if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
    } catch { /* best-effort */ }
  }
}

// ── globals ─────────────────────────────────────────────────────────
let win = null;
let tray = null;
let supervisor = null;
let bootstrap = null;
let quitting = false;
let projectRoot = null;
let updateInfo = null; // {version, name, notes} when newer than installed
let installBusy = false;
let tunnelBusy = false;
let tunnelAbort = null;

// ── self-update of THIS app (the shell) via electron-updater ────────
// Uses the latest.yml + .blockmap that CI already publishes with every
// release. Downloads in the background; applies on "Restart app" or on the
// next quit. Any failure degrades to a "download the new installer" link.
let shellUpdate = { status: 'idle', version: null, progress: null, error: null };
let autoUpdater = null;
let latestReleaseTag = null; // newest tag on GitHub — used to notice an out-of-date shell

/** Updater chatter goes into the App log so a silent failure is never invisible. */
function updaterLog(msg) {
  try {
    supervisor?.appLog(`[app-update] ${String(msg).slice(0, 300)}`);
  } catch { /* ignore */ }
}

function initShellUpdater() {
  if (!app.isPackaged || process.platform !== 'win32') return; // dev / non-win: nothing to do
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.logger = { info: updaterLog, warn: updaterLog, error: updaterLog, debug: () => {} };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // ignored prompt still applies on next restart
    autoUpdater.on('update-available', (info) => {
      shellUpdate = { status: 'downloading', version: info?.version || null, progress: 0, error: null };
      pushState();
    });
    autoUpdater.on('download-progress', (p) => {
      shellUpdate.progress = Math.round(p?.percent || 0);
      pushState();
    });
    autoUpdater.on('update-downloaded', (info) => {
      shellUpdate = { status: 'ready', version: info?.version || shellUpdate.version, progress: 100, error: null };
      notify('Nimbus Drive app update ready', 'Restart the app from the control panel to finish updating.');
      pushState();
    });
    autoUpdater.on('update-not-available', () => {
      if (shellUpdate.status !== 'ready') shellUpdate = { status: 'idle', version: null, progress: null, error: null };
      pushState();
    });
    autoUpdater.on('error', (err) => {
      // never fatal: the UI falls back to a manual installer link
      const msg = String(err?.message || err).slice(0, 200);
      updaterLog(`update failed: ${msg}`);
      shellUpdate = { status: 'error', version: shellUpdate.version, progress: null, error: msg };
      pushState();
    });
  } catch (err) {
    console.warn('[desktop] self-updater unavailable:', err.message);
    autoUpdater = null;
  }
}

function checkShellUpdate() {
  try {
    autoUpdater?.checkForUpdates();
  } catch { /* degrade to the fallback link */ }
}

const homeDir = () => app.getPath('userData');
const iconPath = () => path.join(__dirname, 'assets', 'icon.png');
const isBootstrap = () => appConfig.mode === 'bootstrap';

function looksLikeProject(root) {
  return !!root && fs.existsSync(path.join(root, 'server', 'src', 'index.js')) && fs.existsSync(path.join(root, 'web'));
}

/** Where the canonical .env lives (bootstrap keeps it OUTSIDE versions). */
function envPath() {
  if (isBootstrap()) return bootstrap.canonicalEnvPath();
  return projectRoot ? path.join(projectRoot, '.env') : null;
}

function which(cmd) {
  return new Promise((resolve) => {
    if (path.isAbsolute(cmd)) return resolve(fs.existsSync(cmd) ? cmd : null);
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFile(probe, [cmd], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).split(/\r?\n/)[0].trim() || null);
    });
  });
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, icon: iconPath() }).show();
  } catch { /* non-fatal */ }
}

// ── state assembly ──────────────────────────────────────────────────
function tunnelConfigWarning(env) {
  if (!appConfig.tunnelEnabled || !env) return null;
  let baseHost;
  try {
    baseHost = new URL(env.BASE_URL).hostname;
  } catch {
    return 'BASE_URL is not a valid URL.';
  }
  if (baseHost === 'localhost' || baseHost === '127.0.0.1') {
    return 'The tunnel is enabled but BASE_URL still points at localhost — set it to your public https:// domain so Google sign-in works remotely.';
  }
  for (const p of [path.join(os.homedir(), '.cloudflared', 'config.yml'), projectRoot && path.join(projectRoot, 'cloudflared', 'config.yml')].filter(Boolean)) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const hosts = [...txt.matchAll(/hostname:\s*(\S+)/g)].map((m) => m[1]);
      if (hosts.length && !hosts.includes(baseHost)) {
        return `BASE_URL host "${baseHost}" is not in ${p} (it routes: ${hosts.join(', ')}). Sign-in redirects will break until they match.`;
      }
      if (hosts.length) return null;
    } catch { /* try next */ }
  }
  return null;
}

function publicState() {
  const s = supervisor
    ? supervisor.state()
    : { overall: 'stopped', running: false, services: {}, env: { configured: false }, startError: null, external: null, publicOk: null };
  const env = supervisor ? supervisor.env() : null;
  const cur = isBootstrap() ? bootstrap.current() : null;
  return {
    ...s,
    app: {
      version: app.getVersion(),
      mode: appConfig.mode,
      repo: appConfig.repo,
      defaultRepo: DEFAULT_REPO,
      projectRoot,
      platform: process.platform,
      packaged: app.isPackaged,
      config: {
        tunnelEnabled: appConfig.tunnelEnabled,
        tunnelMode: appConfig.tunnelMode,
        tunnelToken: appConfig.tunnelToken,
        tunnelName: appConfig.tunnelName,
        cloudflaredPath: appConfig.cloudflaredPath,
        startServicesOnLaunch: appConfig.startServicesOnLaunch,
        openAtLogin: app.getLoginItemSettings().openAtLogin,
      },
      localUrl: supervisor ? supervisor.localUrl() : 'http://localhost:3000',
      redirectUri: env ? redirectUri(env.BASE_URL) : null,
      tunnelWarning: tunnelConfigWarning(env),
      install: isBootstrap()
        ? {
            busy: installBusy,
            current: cur ? { version: cur.version, activatedAt: cur.activatedAt } : null,
            previous: bootstrap.previous() ? { version: bootstrap.previous().version } : null,
            update: updateInfo,
            needsRebuild: cur ? bootstrap.needsRebuild() : false,
          }
        : null,
      shellUpdate: {
        ...shellUpdate,
        // A newer release exists than THIS app build. Computed from the release
        // tag directly, so it stays true even when the auto-updater is broken,
        // missing (old build), or the download 404s.
        appOutdated: latestReleaseTag ? isNewerVersion(latestReleaseTag, app.getVersion()) : false,
        latestVersion: latestReleaseTag,
        // offer the manual installer whenever the updater is not actively
        // delivering that newer version
        fallback:
          !!latestReleaseTag &&
          isNewerVersion(latestReleaseTag, app.getVersion()) &&
          !['downloading', 'ready'].includes(shellUpdate.status),
        releasesUrl: `https://github.com/${appConfig.repo || DEFAULT_REPO}/releases/latest`,
      },
    },
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
  updateTray();
}
function pushInstall(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('install', evt);
}

// ── supervisor / bootstrap wiring ───────────────────────────────────
function createSupervisor() {
  supervisor = new Supervisor({
    projectRoot,
    getAppConfig: () => ({
      tunnelEnabled: appConfig.tunnelEnabled,
      // tunnelMode/tunnelToken MUST be forwarded: buildTunnelSpec falls back to
      // 'named' when mode is undefined, so omitting them here silently ignored
      // the user's "Permanent Custom Domain" choice and their pasted token, and
      // forced every start down the named-tunnel path (config.yml + credentials
      // file) even when neither existed on the machine.
      tunnelMode: appConfig.tunnelMode,
      tunnelToken: appConfig.tunnelToken,
      tunnelName: appConfig.tunnelName,
      cloudflaredPath: appConfig.cloudflaredPath,
      nodePath: appConfig.nodePath,
    }),
  });
  supervisor.on('state', pushState);
  supervisor.on('log', ({ proc, entry }) => {
    if (win && !win.isDestroyed()) win.webContents.send('log', { proc, entry });
  });
  supervisor.on('service-failed', ({ name, error }) => {
    notify('Nimbus Drive — service stopped', `${name}: ${error || 'crashed repeatedly'}`);
  });
  supervisor.on('public', (ok) => {
    if (!ok) notify('Nimbus Drive — not reachable from the internet', 'The public URL is not responding. Check the tunnel and your connection.');
  });
}

async function activateVersionDir(dir) {
  if (supervisor) {
    await supervisor.stopAll().catch(() => {});
    supervisor.close();
    supervisor = null;
  }
  projectRoot = dir;
  await bootstrap.materializeEnv(dir).catch(() => {});
  createSupervisor();
}

/** Make sure the private Node runtime exists (bootstrap mode). */
async function ensureRuntime() {
  pushInstall({ step: 'runtime', status: 'running', detail: 'Preparing the Node runtime…' });
  const rt = await ensureNode({
    homeDir: homeDir(),
    onProgress: (p) => pushInstall({ step: 'runtime', status: 'running', detail: 'Downloading the Node runtime…', progress: p.percent }),
  });
  bootstrap.runtime = rt;
  appConfig.nodePath = rt.nodeBin;
  saveConfig();
  pushInstall({ step: 'runtime', status: 'ok', detail: `Node runtime ready (${rt.version})` });
  return rt;
}

async function runInstallFlow(release) {
  installBusy = true;
  pushState();
  try {
    if (supervisor) {
      await supervisor.stopAll().catch(() => {});
    }
    await ensureRuntime();
    const installed = await bootstrap.installVersion(release);
    await activateVersionDir(installed.path);
    updateInfo = null;
    return installed;
  } finally {
    installBusy = false;
    pushState();
  }
}

async function checkForUpdate({ notifyUser = false } = {}) {
  if (!isBootstrap()) return null;
  const parsed = parseRepo(appConfig.repo || DEFAULT_REPO);
  if (!parsed) return null;
  const gh = new GitHub();
  const latest = await gh.latestVersion(parsed.owner, parsed.repo);
  latestReleaseTag = latest?.version || null;
  updateInfo = bootstrap.updateAvailable(latest) ? latest : null;
  if (updateInfo && notifyUser) {
    notify('Nimbus Drive update available', `${updateInfo.name || updateInfo.version} is ready to install from the control panel.`);
  }
  pushState();
  return updateInfo;
}

// ── window & tray ───────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 780,
    minHeight: 560,
    show: !startHidden,
    backgroundColor: '#f5f7f1',   // must match --bg, or the window flashes dark before the page paints
    icon: iconPath(),
    title: 'Nimbus Drive',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide(); // keep serving in the tray
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function updateTray() {
  if (!tray) return;
  const s = supervisor ? supervisor.state() : null;
  const label = !s
    ? 'Nimbus Drive'
    : s.overall === 'online'
      ? 'Nimbus Drive — online'
      : s.overall === 'degraded'
        ? 'Nimbus Drive — problem!'
        : s.running
          ? 'Nimbus Drive — starting…'
          : 'Nimbus Drive — stopped';
  tray.setToolTip(label);
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    const menu = Menu.buildFromTemplate([
      { label: 'Open control panel', click: () => { win.show(); win.focus(); } },
      {
        label: 'Open my drive',
        click: () => {
          const env = supervisor?.env();
          shell.openExternal(env?.BASE_URL?.startsWith('https://') ? env.BASE_URL : supervisor ? supervisor.localUrl() : 'http://localhost:3000');
        },
      },
      { type: 'separator' },
      { label: 'Start services', click: () => supervisor?.start() },
      { label: 'Restart services', click: () => supervisor?.restart() },
      { label: 'Stop services', click: () => supervisor?.stopAll() },
      { type: 'separator' },
      { label: 'Quit (stops the drive)', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => { win.show(); win.focus(); });
    updateTray();
  } catch (err) {
    console.warn('[desktop] tray unavailable:', err.message);
    tray = null;
  }
}

// ── IPC ─────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('services:start', async () => {
    if (supervisor) {
      if (isBootstrap() && projectRoot) await bootstrap.materializeEnv(projectRoot).catch(() => {});
      await supervisor.start();
    }
    return publicState();
  });
  ipcMain.handle('services:stop', async () => { if (supervisor) await supervisor.stopAll(); return publicState(); });
  ipcMain.handle('services:restart', async () => { if (supervisor) await supervisor.restart(); return publicState(); });
  ipcMain.handle('services:restartOne', async (_e, name) => {
    if (supervisor && ['api', 'web', 'tunnel'].includes(name)) await supervisor.restartOne(name);
    return publicState();
  });
  ipcMain.handle('external:takeover', async () => {
    if (supervisor) {
      await supervisor.killExternal();
      await supervisor.start();
    }
    return publicState();
  });

  // ── first-run choices ────────────────────────────────────────────
  ipcMain.handle('setup:install', async (_e, repoInput) => {
    if (installBusy) return { ok: false, error: 'An install is already running.' };
    // No input needed — the app knows its own repo. An explicit value (the
    // hidden "change" option) still wins for advanced setups.
    const parsed = parseRepo(repoInput || appConfig.repo || DEFAULT_REPO);
    if (!parsed) return { ok: false, error: 'Enter the repository as owner/name (e.g. yourname/nimbus-drive) or a github.com link.' };
    appConfig.mode = 'bootstrap';
    appConfig.repo = `${parsed.owner}/${parsed.repo}`;
    saveConfig();
    try {
      pushInstall({ step: 'find', status: 'running', detail: `Looking up ${appConfig.repo} on GitHub…` });
      const gh = new GitHub();
      const latest = await gh.latestVersion(parsed.owner, parsed.repo);
      pushInstall({ step: 'find', status: 'ok', detail: `Found ${latest.name || latest.version}` });
      await runInstallFlow(latest);
      return { ok: true, state: publicState() };
    } catch (err) {
      pushInstall({ step: 'error', status: 'fail', detail: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setup:locate', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Locate your nimbus-drive folder', properties: ['openDirectory'] });
    if (res.canceled) return { ok: false };
    const chosen = res.filePaths[0];
    if (!looksLikeProject(chosen)) {
      return { ok: false, error: 'That folder does not look like a Nimbus Drive project (server/src/index.js not found).' };
    }
    appConfig.mode = 'checkout';
    appConfig.projectRoot = chosen;
    appConfig.nodePath = 'node';
    saveConfig();
    projectRoot = chosen;
    if (supervisor) supervisor.close();
    createSupervisor();
    pushState();
    return { ok: true };
  });

  ipcMain.handle('install:cancel', () => {
    bootstrap?.cancel();
    return { ok: true };
  });

function relaunchApp() {
  quitting = true;
  try {
    if (supervisor) {
      supervisor.stopAll().catch(() => {});
      supervisor.close();
    }
  } catch { /* ignore */ }
  app.relaunch();
  app.exit(0);
}

  // ── updates ──────────────────────────────────────────────────────
  ipcMain.handle('update:check', async () => {
    try {
      await checkForUpdate();
      checkShellUpdate();
      return { ok: true, update: updateInfo, state: publicState() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('update:run', async () => {
    if (!isBootstrap() || !updateInfo) return { ok: false, error: 'No update available.' };
    if (installBusy) return { ok: false, error: 'An install is already running.' };
    const target = updateInfo;
    try {
      if (supervisor) await supervisor.stopAll();
      await runInstallFlow(target);
      if (bootstrap) await bootstrap.prune().catch(() => {});
      notify('Nimbus Drive updated', `Now running ${target.name || target.version}.`);

      if (autoUpdater && shellUpdate.status === 'ready') {
        quitting = true;
        autoUpdater.quitAndInstall(false, true);
        return { ok: true, restarting: true, state: publicState() };
      }

      setTimeout(() => {
        relaunchApp();
      }, 1000);
      return { ok: true, restarting: true, state: publicState() };
    } catch (err) {
      if (supervisor) await supervisor.start().catch(() => {});
      return { ok: false, error: `Update failed (your current version is untouched): ${err.message}` };
    }
  });

  ipcMain.handle('update:rollback', async () => {
    if (!isBootstrap()) return { ok: false, error: 'Not available here.' };
    try {
      const wasRunning = supervisor?.running;
      if (supervisor) await supervisor.stopAll();
      const rolled = await bootstrap.rollback();
      await activateVersionDir(rolled.path);
      if (wasRunning || appConfig.startServicesOnLaunch) await supervisor.start();
      await checkForUpdate().catch(() => {});
      return { ok: true, state: publicState() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell-update:install', async () => {
    if (!autoUpdater || shellUpdate.status !== 'ready') return { ok: false, error: 'No app update is ready.' };
    try {
      if (supervisor) await supervisor.stopAll(); // hand over cleanly before the installer runs
      quitting = true; // skip our before-quit interception
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      quitting = false;
      return { ok: false, error: err.message };
    }
  });

  // Full domain + browser-sign-in verification, on demand.
  ipcMain.handle('verify:run', async () => {
    try {
      const env = supervisor?.env() || readEnv(envPath()) || {};
      return {
        ok: true,
        report: await runDiagnostics({
          env,
          apiPort: supervisor?.apiPort,
          webPort: supervisor?.webPort,
          tunnelEnabled: appConfig.tunnelEnabled,
          tunnelMode: appConfig.tunnelMode,
          projectRoot,
          homeDir: os.homedir(),
        }),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Cloudflare tunnel: install, authorize, create, route ─────────
  // Everything SETUP.md used to ask people to type in a terminal. cloudflared
  // does the work; the app only drives it and shows what is happening.
  const cfHome = () => os.homedir();
  const pushTunnel = (evt) => { if (win && !win.isDestroyed()) win.webContents.send('tunnel-step', evt); };
  const findCloudflared = async () => (await which(appConfig.cloudflaredPath || 'cloudflared')) || null;

  async function installCloudflared() {
    pushTunnel({ step: 'install', status: 'running', detail: 'Downloading cloudflared…' });
    const got = await ensureCloudflared({
      homeDir: homeDir(),
      onProgress: (p) => pushTunnel({ step: 'install', status: 'running', detail: 'Downloading cloudflared…', progress: p.percent }),
    });
    appConfig.cloudflaredPath = got;
    saveConfig();
    pushTunnel({ step: 'install', status: 'ok', detail: 'cloudflared is installed.' });
    return got;
  }

  ipcMain.handle('tunnel:status', async () => {
    try {
      const env = supervisor?.env() || readEnv(envPath()) || {};
      const bin = await findCloudflared();
      const st = await cfTunnel.status({
        bin, home: cfHome(), baseUrl: env.BASE_URL, tunnelName: appConfig.tunnelName || 'nimbus',
      });
      return { ok: true, status: { ...st, bin, baseUrl: env.BASE_URL || null } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tunnel:install', async () => {
    try { return { ok: true, path: await installCloudflared() }; }
    catch (err) { pushTunnel({ step: 'install', status: 'fail', detail: err.message }); return { ok: false, error: err.message }; }
  });

  ipcMain.handle('tunnel:setup', async (_e, opts = {}) => {
    if (tunnelBusy) return { ok: false, error: 'Tunnel setup is already running.' };
    tunnelBusy = true;
    tunnelAbort = new AbortController();
    try {
      const env = supervisor?.env() || readEnv(envPath()) || {};
      const hostname = String(opts.hostname || '').trim() || hostnameFromBaseUrl(env.BASE_URL);
      if (!hostname) {
        const msg = 'Set BASE_URL in Settings to the address family will use (for example https://cloud.example.com), then run this again.';
        pushTunnel({ step: 'done', status: 'fail', detail: msg });
        return { ok: false, error: msg };
      }
      const bin = (await findCloudflared()) || (await installCloudflared());
      const res = await cfTunnel.setup({
        bin,
        home: cfHome(),
        name: appConfig.tunnelName || 'nimbus',
        hostname,
        port: supervisor?.webPort || 3000,
        overwriteDns: !!opts.overwriteDns,
        recreate: !!opts.recreate,
        signal: tunnelAbort.signal,
        onStep: (evt) => {
          pushTunnel(evt);
          // the authorization page must open by itself — nobody should have to
          // copy a URL out of a log
          if (evt.url) shell.openExternal(evt.url).catch(() => {});
        },
      });
      // a completed setup IS a named tunnel; leaving the mode elsewhere would
      // silently ignore everything that was just created
      appConfig.tunnelEnabled = true;
      appConfig.tunnelMode = 'named';
      saveConfig();
      pushTunnel({ step: 'done', status: 'ok', detail: `Ready — ${res.hostname} now reaches this PC.` });
      pushState();
      return { ok: true, result: res, state: publicState() };
    } catch (err) {
      const cancelled = /cancel/i.test(err.message || '');
      pushTunnel({ step: 'done', status: 'fail', detail: cancelled ? 'Cancelled.' : err.message });
      return { ok: false, error: err.message, cancelled, needsOverwrite: !!err.needsOverwrite, needsRecreate: !!err.needsRecreate };
    } finally {
      tunnelBusy = false;
      tunnelAbort = null;
    }
  });

  ipcMain.handle('tunnel:cancel', () => { tunnelAbort?.abort(); return { ok: true }; });

  ipcMain.handle('tunnel:delete', async (_e, name) => {
    try {
      const bin = await findCloudflared();
      if (!bin) return { ok: false, error: 'cloudflared is not installed yet.' };
      await cfTunnel.deleteTunnel({ bin, home: cfHome(), name: name || appConfig.tunnelName || 'nimbus' });
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('open:releases', () => {
    return shell.openExternal(`https://github.com/${appConfig.repo || DEFAULT_REPO}/releases/latest`);
  });

  ipcMain.handle('rebuild:run', async () => {
    if (!isBootstrap()) return { ok: false, error: 'Not available here.' };
    if (installBusy) return { ok: false, error: 'An install is already running.' };
    installBusy = true;
    pushState();
    try {
      const wasRunning = supervisor?.running;
      if (supervisor) await supervisor.stopAll();
      await ensureRuntime();
      await bootstrap.rebuildActive();
      if (wasRunning || appConfig.startServicesOnLaunch) await supervisor.start();
      return { ok: true, state: publicState() };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      installBusy = false;
      pushState();
    }
  });

  // ── configuration ────────────────────────────────────────────────
  ipcMain.handle('config:get', () => {
    const p = envPath();
    if (!p) return { env: {}, configured: false, app: publicState().app };
    const env = readEnv(p) || {};
    return {
      env: {
        APP_NAME: env.APP_NAME || 'Nimbus Drive',
        BASE_URL: env.BASE_URL || 'http://localhost:3000',
        STORAGE_ROOT: env.STORAGE_ROOT || (isBootstrap() ? path.join(os.homedir(), 'NimbusDriveFiles') : path.join(projectRoot, 'storage')),
        ADMIN_EMAIL: env.ADMIN_EMAIL || '',
        GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || '',
        GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET || '',
        API_PORT: env.API_PORT || '4400',
      },
      configured: !!readEnv(p),
      app: publicState().app,
    };
  });

  ipcMain.handle('config:save', async (_e, payload) => {
    const p = envPath();
    if (!p) return { ok: false, problems: [{ field: '', message: 'Install Nimbus Drive or locate your folder first.' }] };
    const { env: envValues, app: appValues } = payload || {};
    if (envValues) {
      const problems = validateEnvValues(envValues, { projectRoot: projectRoot || homeDir() });
      if (problems.length) return { ok: false, problems };
      const defaults = isBootstrap() ? { DATA_DIR: path.join(homeDir(), 'data') } : {};
      // Never let a write failure reject the IPC — the UI must be able to show
      // WHY saving failed (missing folder, permissions, file locked by OneDrive…).
      try {
        if (fs.existsSync(p)) updateEnv(p, envValues);
        else createEnv(p, { ...defaults, ...envValues });
        if (isBootstrap() && projectRoot) await bootstrap.materializeEnv(projectRoot);
      } catch (err) {
        const why = err.code === 'EACCES' || err.code === 'EPERM'
          ? 'the file is locked or not writable (close any editor, or check OneDrive sync)'
          : err.code === 'ENOENT'
            ? 'the settings folder could not be created'
            : err.message;
        return { ok: false, problems: [{ field: '', message: `Could not save settings to ${p} — ${why}` }] };
      }
    }
    if (appValues) {
      // auto-fetch cloudflared for bootstrap users the first time they enable the tunnel
      if (appValues.tunnelEnabled && isBootstrap()) {
        const bin = appValues.cloudflaredPath || appConfig.cloudflaredPath;
        if (!(await which(bin))) {
          try {
            pushInstall({ step: 'cloudflared', status: 'running', detail: 'Downloading cloudflared…' });
            const got = await ensureCloudflared({
              homeDir: homeDir(),
              onProgress: (pr) => pushInstall({ step: 'cloudflared', status: 'running', detail: 'Downloading cloudflared…', progress: pr.percent }),
            });
            appValues.cloudflaredPath = got;
            pushInstall({ step: 'cloudflared', status: 'ok', detail: 'cloudflared ready' });
          } catch (err) {
            pushInstall({ step: 'cloudflared', status: 'fail', detail: err.message });
            return { ok: false, problems: [{ field: 'tunnel', message: `Could not download cloudflared: ${err.message}` }] };
          }
        }
      }

      for (const k of ['tunnelEnabled', 'tunnelMode', 'tunnelName', 'tunnelToken', 'cloudflaredPath', 'startServicesOnLaunch']) {
        if (k in appValues) appConfig[k] = appValues[k];
      }
      saveConfig();
      if ('openAtLogin' in appValues) {
        const args = app.isPackaged ? ['--hidden', '--autostart'] : [path.resolve(__dirname), '--hidden', '--autostart'];
        app.setLoginItemSettings({ openAtLogin: !!appValues.openAtLogin, args });
        configureWindowsStartup(!!appValues.openAtLogin);
      }
    }
    pushState();
    return { ok: true, restartNeeded: !!supervisor?.running, state: publicState() };
  });

  ipcMain.handle('dialog:pickFolder', async (_e, current) => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the folder where your files will live',
      defaultPath: current || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('logs:get', (_e, { proc, afterId, filter }) => {
    const buf = supervisor?.logs[proc];
    return buf ? buf.get({ afterId, filter, limit: 800 }) : [];
  });
  ipcMain.handle('logs:export', async (_e, proc) => {
    const buf = supervisor?.logs[proc];
    if (!buf) return { ok: false };
    const res = await dialog.showSaveDialog(win, {
      title: 'Export log',
      defaultPath: path.join(app.getPath('downloads'), `nimbus-${proc}-log.txt`),
    });
    if (res.canceled || !res.filePath) return { ok: false };
    fs.writeFileSync(res.filePath, buf.text());
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('open:link', (_e, which_) => {
    const env = supervisor?.env();
    if (which_ === 'drive') {
      const url = env?.BASE_URL?.startsWith('https://') ? env.BASE_URL : supervisor ? supervisor.localUrl() : 'http://localhost:3000';
      return shell.openExternal(url);
    }
    if (which_ === 'google-console') return shell.openExternal('https://console.cloud.google.com/apis/credentials');
    if (which_ === 'storage') {
      const root = env?.STORAGE_ROOT || '';
      const abs = path.isAbsolute(root) ? root : path.resolve(projectRoot || homeDir(), root || 'storage');
      try { fs.mkdirSync(abs, { recursive: true }); } catch { /* ignore */ }
      return shell.openPath(abs);
    }
    if (which_ === 'logs-folder') {
      const env2 = supervisor?.env() || {};
      const dd = env2.DATA_DIR
        ? path.isAbsolute(env2.DATA_DIR) ? env2.DATA_DIR : path.resolve(projectRoot || homeDir(), env2.DATA_DIR)
        : path.join(projectRoot || homeDir(), 'data');
      return shell.openPath(path.join(dd, 'logs'));
    }
    return null;
  });
}

// ── lifecycle ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    loadConfig();
    bootstrap = new Bootstrap({ homeDir: homeDir() });
    bootstrap.on('step', (s) => pushInstall(s));
    bootstrap.on('steplog', (l) => pushInstall({ step: l.step, status: 'log', detail: l.line }));
    bootstrap.sweepTrash(); // clear leftovers from previous updates, in the background

    // resolve where the project lives
    if (isBootstrap() && bootstrap.current()) {
      projectRoot = bootstrap.current().path;
      try {
        bootstrap.runtime = await ensureNode({ homeDir: homeDir() }); // cached, instant
        appConfig.nodePath = bootstrap.runtime.nodeBin;
      } catch { /* runtime re-download will be offered on demand */ }
      await bootstrap.materializeEnv(projectRoot).catch(() => {});
      createSupervisor();
      bootstrap.prune().catch(() => {});
    } else if (appConfig.mode === 'checkout' && looksLikeProject(appConfig.projectRoot)) {
      projectRoot = appConfig.projectRoot;
      createSupervisor();
    } else {
      const devGuess = path.resolve(__dirname, '..');
      if (!app.isPackaged && looksLikeProject(devGuess)) {
        appConfig.mode = 'checkout';
        appConfig.projectRoot = devGuess;
        saveConfig();
        projectRoot = devGuess;
        createSupervisor();
      }
    }

    registerIpc();
    createWindow();
    createTray();

    if (supervisor) {
      const configured = !!readEnv(path.join(projectRoot, '.env'));
      if (configured && appConfig.startServicesOnLaunch) supervisor.start().catch(() => {});
    }

    // update awareness (code + this app): on launch and daily
    initShellUpdater();
    checkForUpdate({ notifyUser: true }).catch(() => {});
    checkShellUpdate();
    const daily = setInterval(() => {
      checkForUpdate({ notifyUser: true }).catch(() => {});
      checkShellUpdate();
    }, 24 * 3600 * 1000);
    if (daily.unref) daily.unref();
  });

  app.on('activate', () => { if (win) win.show(); });

  app.on('before-quit', async (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    try {
      bootstrap?.cancel();
      if (supervisor) {
        await Promise.race([supervisor.stopAll(), new Promise((r) => setTimeout(r, 8000))]);
        supervisor.close();
      }
    } finally {
      app.exit(0);
    }
  });

  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });
}
