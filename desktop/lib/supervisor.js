'use strict';
/**
 * Supervisor — owns the three services (API, Web, Cloudflare Tunnel):
 *  - resolves ports before starting (auto-heals conflicts, persists API_PORT)
 *  - detects a Nimbus instance already running outside the app (adopt/replace)
 *  - spawns each service as a ManagedProcess with crash auto-restart
 *  - polls health endpoints and drives status pills
 *  - verifies the PUBLIC url end-to-end when the tunnel is enabled
 */
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { readEnv, updateEnv } = require('./env');
const { isPortFree, findFreePort, findPidOnPort } = require('./ports');
const { ManagedProcess } = require('./procman');
const { LogBuffer } = require('./logbuf');

const WEB_PORT_DEFAULT = 3000;

function fetchJson(url, timeoutMs = 4000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
    .catch(() => null);
}
function fetchStatus(url, timeoutMs = 4000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    .then((r) => r.status)
    .catch(() => 0);
}

function which(cmd) {
  return new Promise((resolve) => {
    if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return resolve(cmd);
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFile(probe, [cmd], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).split(/\r?\n/)[0].trim() || null);
    });
  });
}

class Supervisor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot  the nimbus-drive folder
   * @param {() => object} opts.getAppConfig  desktop settings {tunnelEnabled, tunnelName, cloudflaredPath, nodePath}
   * @param {object} [opts.tuning]     test overrides {backoff, healthIntervalMs, publicIntervalMs}
   */
  constructor({ projectRoot, getAppConfig, tuning = {} }) {
    super();
    this.projectRoot = projectRoot;
    this.getAppConfig = getAppConfig;
    this.tuning = tuning;

    // Logs live inside the drive's DATA_DIR (so "backup = storage + data/" stays true).
    const envNow = readEnv(path.join(projectRoot, '.env')) || {};
    const dataDir = envNow.DATA_DIR
      ? path.isAbsolute(envNow.DATA_DIR) ? envNow.DATA_DIR : path.resolve(projectRoot, envNow.DATA_DIR)
      : path.join(projectRoot, 'data');
    const logDir = path.join(dataDir, 'logs');
    this.logs = {
      app: new LogBuffer({ name: 'app', filePath: path.join(logDir, 'desktop.log') }),
      api: new LogBuffer({ name: 'api', filePath: path.join(logDir, 'api.log') }),
      web: new LogBuffer({ name: 'web', filePath: path.join(logDir, 'web.log') }),
      tunnel: new LogBuffer({ name: 'tunnel', filePath: path.join(logDir, 'tunnel.log') }),
    };
    for (const [name, buf] of Object.entries(this.logs)) {
      buf.on('line', (entry) => this.emit('log', { proc: name, entry }));
    }

    this.procs = {};
    this.running = false;
    this.apiPort = null;
    this.webPort = null;
    this.external = null; // {kind:'api'|'web', port, pid} — a Nimbus running outside the app
    this.publicOk = null; // null unknown | true | false
    this.lastPublicCheck = 0;
    this.healthTimer = null;
    this.startError = null;
  }

  env() {
    return readEnv(path.join(this.projectRoot, '.env'));
  }

  appLog(msg, level = 'info') {
    this.logs.app.push(msg, level);
  }

  /** Is a Nimbus web/api already listening on this port (started outside us)? */
  async _detectNimbus(port, kind) {
    const res = await fetchJson(`http://127.0.0.1:${port}/api/health`, 2500);
    if (res && res.status === 200 && res.body && res.body.ok === true) {
      const pid = await findPidOnPort(port);
      return { kind, port, pid, appName: res.body.app || 'Nimbus' };
    }
    return null;
  }

  /**
   * Resolve API and web ports before starting.
   *  - preferred ports free → use them
   *  - occupied by an external Nimbus → report it (caller decides: adopt or replace)
   *  - occupied by something else → auto-heal to the next free port
   * API_PORT changes are persisted to .env (both the API and the Next proxy read it).
   */
  async resolvePorts() {
    const envPath = path.join(this.projectRoot, '.env');
    const env = readEnv(envPath) || {};
    const wantApi = Number(env.API_PORT || 4400);
    let base;
    try {
      base = new URL(env.BASE_URL || 'http://localhost:3000');
    } catch {
      base = new URL('http://localhost:3000');
    }
    const wantWeb = base.hostname === 'localhost' || base.hostname === '127.0.0.1'
      ? Number(base.port || WEB_PORT_DEFAULT)
      : WEB_PORT_DEFAULT;

    const isPortFreeWithRetry = async (port, retries = 3, delayMs = 300) => {
      for (let i = 0; i < retries; i++) {
        if (await isPortFree(port)) return true;
        if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
      return false;
    };

    // web port first (it's the user-facing one) — safe to heal at runtime:
    // `next start` honors PORT, and the tunnel gets a --url override.
    let webPort = wantWeb;
    if (!(await isPortFreeWithRetry(webPort))) {
      const external = await this._detectNimbus(webPort, 'web');
      if (external) return { external };
      webPort = await findFreePort(wantWeb + 1);
      this.appLog(`Port ${wantWeb} is in use by another program — using ${webPort} for the web app instead.`, 'warn');
    }

    // API port is different: the web build BAKES the /api proxy target in at
    // build time (routes-manifest), so silently moving it would half-break the
    // app. If something else owns it: take over a stale Nimbus, otherwise stop
    // with a clear explanation instead of limping.
    const apiPort = wantApi;
    if (!(await isPortFreeWithRetry(apiPort))) {
      const external = await this._detectNimbus(apiPort, 'api');
      if (external) return { external };
      const suggestion = await findFreePort(wantApi + 1);
      return {
        error:
          `Port ${apiPort} (the Nimbus API port) is in use by another program. ` +
          `Close that program, or change API_PORT in .env to a free port (e.g. ${suggestion}) ` +
          `and run "npm run build" once so the web app follows it.`,
      };
    }

    // If BASE_URL points at localhost with the old web port, keep it in sync so
    // sign-in redirects still work locally.
    if ((base.hostname === 'localhost' || base.hostname === '127.0.0.1') && Number(base.port || 80) !== webPort) {
      base.port = String(webPort);
      updateEnv(envPath, { BASE_URL: base.origin });
      this.appLog(`BASE_URL updated to ${base.origin} to match the new web port. If Google sign-in complains, add this redirect URI in Google Console: ${base.origin}/api/auth/callback/google`, 'warn');
    }

    return { apiPort, webPort };
  }

  async killExternal() {
    if (!this.external || !this.external.pid) return false;
    const pid = this.external.pid;
    this.appLog(`Stopping the Nimbus instance already running outside the app (pid ${pid})…`, 'warn');
    if (process.platform === 'win32') {
      await new Promise((resolve) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, 800));
    this.external = null;
    return true;
  }

  async start() {
    if (this.running) return this.state();
    this.startError = null;
    this.external = null;
    this.publicOk = null;

    const env = this.env();
    if (!env) {
      this.startError = 'No .env configuration yet — finish setup first.';
      this.emit('state', this.state());
      return this.state();
    }

    const cfg = this.getAppConfig();
    const nodeCmd = cfg.nodePath || 'node';
    if (!(await which(nodeCmd))) {
      this.startError = 'Node.js was not found on this computer. Install Node.js 20+ from nodejs.org, then try again.';
      this.appLog(this.startError, 'error');
      this.emit('state', this.state());
      return this.state();
    }

    const resolved = await this.resolvePorts();
    if (resolved.external) {
      this.external = resolved.external;
      this.startError = `Nimbus is already running outside the app (port ${resolved.external.port}${resolved.external.pid ? `, pid ${resolved.external.pid}` : ''}) — likely the old auto-start script. Use "Take over" to stop it and let the app manage it.`;
      this.appLog(this.startError, 'warn');
      this.emit('state', this.state());
      return this.state();
    }
    if (resolved.error) {
      this.startError = resolved.error;
      this.appLog(resolved.error, 'error');
      this.emit('state', this.state());
      return this.state();
    }
    this.apiPort = resolved.apiPort;
    this.webPort = resolved.webPort;

    const root = this.projectRoot;
    const tuning = this.tuning;
    const mk = (name, getSpec) =>
      new ManagedProcess({ name, getSpec, log: this.logs[name], ...(tuning.backoff ? { backoff: tuning.backoff } : {}) });

    this.procs.api = mk('api', () => ({
      cmd: nodeCmd,
      args: [path.join('src', 'index.js')],
      cwd: path.join(root, 'server'),
      env: { API_PORT: String(this.apiPort) },
    }));

    this.procs.web = mk('web', () => {
      const nextBin = path.join(root, 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
      if (!fs.existsSync(nextBin)) throw new Error('web/node_modules is missing — run "npm run install:all" once.');
      if (!fs.existsSync(path.join(root, 'web', '.next', 'BUILD_ID'))) {
        throw new Error('The web app has not been built — run "npm run build" once (or use Update in a later version).');
      }
      return {
        cmd: nodeCmd,
        args: [nextBin, 'start'],
        cwd: path.join(root, 'web'), // cwd matters: next.config reads ../.env from here
        env: { PORT: String(this.webPort), NODE_ENV: 'production' },
      };
    });

    if (cfg.tunnelEnabled) {
      this.procs.tunnel = mk('tunnel', () => {
        const bin = cfg.cloudflaredPath || 'cloudflared';
        const mode = cfg.tunnelMode || (cfg.tunnelToken ? 'token' : 'named'); // default preserves existing named tunnels (quick URLs rotate and break OAuth)
        let args = [];
        if (mode === 'token' && cfg.tunnelToken) {
          args = ['tunnel', 'run', '--token', cfg.tunnelToken.trim()];
        } else if (mode === 'named') {
          args = ['tunnel', 'run'];
          const projConfig = path.join(root, 'cloudflared', 'config.yml');
          const osHome = process.env.USERPROFILE || process.env.HOME || '';
          const userConfig = osHome ? path.join(osHome, '.cloudflared', 'config.yml') : null;
          const configToUse = fs.existsSync(projConfig) ? projConfig : (userConfig && fs.existsSync(userConfig) ? userConfig : null);
          if (configToUse) {
            args.push('--config', configToUse);
            try {
              let txt = fs.readFileSync(configToUse, 'utf8');
              const updated = txt.replace(/service:\s*http:\/\/(?:localhost|127\.0\.0\.1):\d+/g, `service: http://localhost:${this.webPort}`);
              if (updated !== txt) fs.writeFileSync(configToUse, updated, 'utf8');
            } catch { /* best effort */ }
          }
          args.push(cfg.tunnelName || 'nimbus');
        } else {
          // Quick Tunnel — instant free trycloudflare.com URL
          args = ['tunnel', '--url', `http://localhost:${this.webPort}`];
        }
        return { cmd: bin, args, cwd: root };
      });
    } else {
      delete this.procs.tunnel;
    }

    for (const p of Object.values(this.procs)) {
      p.removeAllListeners('status');
      p.removeAllListeners('failed');
      p.on('status', () => this.emit('state', this.state()));
      p.on('failed', (info) => this.emit('service-failed', info));
    }

    this.running = true;
    this.appLog(`Starting Nimbus — web on :${this.webPort}, API on :${this.apiPort}${this.procs.tunnel ? ', tunnel enabled' : ''}`);
    for (const p of Object.values(this.procs)) p.start();
    this._startHealthLoop();
    this.emit('state', this.state());
    return this.state();
  }

  _startHealthLoop() {
    const interval = this.tuning.healthIntervalMs || 3000;
    const publicEvery = this.tuning.publicIntervalMs || 60000;
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      if (!this.running) return;
      const api = this.procs.api;
      const web = this.procs.web;
      if (api && api.child) {
        const res = await fetchJson(`http://127.0.0.1:${this.apiPort}/api/health`, 2500);
        if (res && res.status === 200 && res.body?.ok) api.markOnline();
        else api.markUnhealthy();
      }
      if (web && web.child) {
        const status = await fetchStatus(`http://127.0.0.1:${this.webPort}/`, 3500);
        if (status > 0 && status < 500) web.markOnline();
        else web.markUnhealthy();
      }
      const tunnel = this.procs.tunnel;
      if (tunnel && tunnel.child && tunnel.status === 'starting') {
        // cloudflared has no local health endpoint by default; a few seconds of
        // stable run time is our "connected" signal, refined by the public check.
        if (Date.now() - tunnel.startedAt > 5000) tunnel.markOnline();
      }
      // End-to-end public reachability (only meaningful with a public BASE_URL + tunnel)
      const env = this.env();
      const base = String(env?.BASE_URL || '');
      const isPublic = base.startsWith('https://');
      if (this.procs.tunnel && isPublic && Date.now() - this.lastPublicCheck > publicEvery) {
        this.lastPublicCheck = Date.now();
        const res = await fetchJson(`${base.replace(/\/+$/, '')}/api/health`, 6000);
        const ok = !!(res && res.status === 200 && res.body?.ok);
        if (this.publicOk !== ok) {
          this.publicOk = ok;
          this.appLog(ok ? `Public URL is reachable: ${base}` : `Public URL is NOT reachable yet: ${base} (tunnel starting, DNS, or internet issue)`, ok ? 'info' : 'warn');
          this.emit('public', ok);
        }
      }
      this.emit('state', this.state());
    }, interval);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  async stopAll() {
    this.running = false;
    clearInterval(this.healthTimer);
    this.healthTimer = null;
    const procs = Object.values(this.procs);
    await Promise.all(procs.map((p) => p.stop().catch(() => {})));
    this.publicOk = null;
    this.appLog('All services stopped.');
    this.emit('state', this.state());
  }

  async restart() {
    await this.stopAll();
    await new Promise((r) => setTimeout(r, 500));
    return this.start();
  }

  async restartOne(name) {
    const p = this.procs[name];
    if (!p) return;
    await p.stop();
    if (this.running) p.start();
  }

  state() {
    const env = this.env();
    const services = {};
    for (const [name, p] of Object.entries(this.procs)) services[name] = p.snapshot();
    const statuses = Object.values(services).map((s) => s.status);
    let overall = 'stopped';
    if (this.running) {
      if (statuses.length === 0) overall = 'starting';
      else if (statuses.every((s) => s === 'online')) overall = 'online';
      else if (statuses.some((s) => s === 'failed')) overall = 'degraded';
      else overall = 'starting';
    } else if (this.external) {
      overall = 'external';
    }
    return {
      overall,
      running: this.running,
      services,
      apiPort: this.apiPort,
      webPort: this.webPort,
      external: this.external,
      publicOk: this.publicOk,
      startError: this.startError,
      env: env
        ? {
            configured: true,
            appName: env.APP_NAME || 'Nimbus Drive',
            baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
            storageRoot: env.STORAGE_ROOT || '',
            adminEmail: env.ADMIN_EMAIL || '',
          }
        : { configured: false },
    };
  }

  localUrl() {
    return `http://localhost:${this.webPort || WEB_PORT_DEFAULT}`;
  }

  close() {
    clearInterval(this.healthTimer);
    for (const buf of Object.values(this.logs)) buf.close();
  }
}

module.exports = { Supervisor };
