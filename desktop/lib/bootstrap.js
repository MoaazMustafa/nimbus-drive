'use strict';
/**
 * Bootstrap engine — turns "a downloaded Setup.exe" into a running Nimbus:
 *
 *   fetch code from GitHub  →  install dependencies  →  build the web app
 *   →  activate the version →  (supervisor runs it)
 *
 * Reliability rules baked in:
 *  - a new version is staged in its own folder and only ACTIVATED after every
 *    step succeeded — a failed download/install/build can never break the
 *    version that is currently working
 *  - the previous version is kept for one-click rollback
 *  - every step streams progress + logs to the UI and is retryable
 */
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { downloadFile } = require('./download');
const { extractArchive } = require('./runtime');
const { readEnv } = require('./env');

const KEEP_VERSIONS = 2;

function sanitizeVersion(v) {
  return String(v).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'unknown';
}

/**
 * Move directory safely on Windows and Unix, retrying on transient locks (EPERM, EBUSY)
 * and falling back to copy+delete if atomic rename is blocked.
 */
async function safeMoveDir(srcDir, destDir, maxRetries = 10) {
  await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});

  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fsp.rename(srcDir, destDir);
      return;
    } catch (err) {
      lastErr = err;
      if (['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'EXDEV'].includes(err.code) || String(err.message).includes('PERM')) {
        await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }

  try {
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.cp(srcDir, destDir, { recursive: true, force: true });
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {});
  } catch (cpErr) {
    throw new Error(`Failed to activate directory (${lastErr?.message || cpErr.message})`);
  }
}

class Bootstrap extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.homeDir           app-owned dir (userData) for versions/ runtime/ config/
   * @param {{nodeBin:string, npmCli:string}} [opts.runtime]  set after ensureNode
   */
  constructor({ homeDir, runtime = null }) {
    super();
    this.homeDir = homeDir;
    this.runtime = runtime;
    this.versionsDir = path.join(homeDir, 'versions');
    this.currentFile = path.join(homeDir, 'current.json');
    this.configDir = path.join(homeDir, 'config');
    this.busy = false;
    this.abort = null;
    this.children = new Set();
  }

  step(step, status, detail = '', extra = {}) {
    this.emit('step', { step, status, detail, ...extra });
  }
  log(step, line) {
    this.emit('steplog', { step, line: String(line).trimEnd() });
  }

  current() {
    try {
      const cur = JSON.parse(fs.readFileSync(this.currentFile, 'utf8'));
      if (cur && cur.path && fs.existsSync(path.join(cur.path, 'server', 'src', 'index.js'))) return cur;
      return null;
    } catch {
      return null;
    }
  }

  listVersions() {
    try {
      return fs
        .readdirSync(this.versionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.endsWith('.staging') && !d.name.startsWith('.'))
        .map((d) => {
          const p = path.join(this.versionsDir, d.name);
          let meta = {};
          try { meta = JSON.parse(fs.readFileSync(path.join(p, '.nimbus-version.json'), 'utf8')); } catch { /* ignore */ }
          return { name: d.name, path: p, installedAt: meta.installedAt || 0, version: meta.version || d.name, notes: meta.notes || '' };
        })
        .sort((a, b) => b.installedAt - a.installedAt);
    } catch {
      return [];
    }
  }

  previous() {
    const cur = this.current();
    return this.listVersions().find((v) => !cur || v.path !== cur.path) || null;
  }

  /** Canonical .env lives in config/; each version gets a materialized copy. */
  canonicalEnvPath() {
    return path.join(this.configDir, '.env');
  }
  async materializeEnv(versionDir) {
    const src = this.canonicalEnvPath();
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(versionDir, '.env'));
    }
  }
  async captureEnv(versionDir) {
    const src = path.join(versionDir, '.env');
    if (fs.existsSync(src)) {
      await fsp.mkdir(this.configDir, { recursive: true });
      await fsp.copyFile(src, this.canonicalEnvPath());
    }
  }

  _spawnLogged(step, cmd, args, { cwd, env = {} } = {}) {
    return new Promise((resolve, reject) => {
      if (this.abort?.signal.aborted) return reject(new Error('cancelled'));
      const nodeDir = this.runtime ? path.dirname(this.runtime.nodeBin) : null;
      const child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          ...(nodeDir ? { PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}` } : {}),
          NEXT_TELEMETRY_DISABLED: '1',
          NO_UPDATE_NOTIFIER: '1',
          npm_config_update_notifier: 'false',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.children.add(child);
      child.stdout.on('data', (d) => this.log(step, d.toString()));
      child.stderr.on('data', (d) => this.log(step, d.toString()));
      const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
      this.abort?.signal.addEventListener('abort', onAbort, { once: true });
      child.once('error', (err) => {
        this.children.delete(child);
        reject(err);
      });
      child.once('exit', (code) => {
        this.children.delete(child);
        this.abort?.signal.removeEventListener('abort', onAbort);
        if (this.abort?.signal.aborted) reject(new Error('cancelled'));
        else if (code === 0) resolve();
        else reject(new Error(`${path.basename(cmd)} exited with code ${code} — see the install log`));
      });
    });
  }

  async _npm(step, args, cwd) {
    if (!this.runtime) throw new Error('runtime not ready');
    await this._spawnLogged(step, this.runtime.nodeBin, [this.runtime.npmCli, ...args], { cwd });
  }

  /**
   * Install (or update to) a specific version. Never touches the active
   * version until everything succeeded.
   * @param {{version:string, tarballUrl:string, name?:string, notes?:string}} release
   * @returns {{version:string, path:string}}
   */
  async installVersion(release) {
    if (this.busy) throw new Error('An install is already running');
    this.busy = true;
    this.abort = new AbortController();
    const tag = sanitizeVersion(release.version);
    const finalDir = path.join(this.versionsDir, tag);
    const staging = `${finalDir}.staging`;
    const tarball = path.join(this.versionsDir, `${tag}.tgz`);
    try {
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(staging, { recursive: true });

      // 1 — download the code
      this.step('download', 'running', `Downloading Nimbus Drive ${release.version}…`);
      const downloadUrls = release.tarballUrls || (release.tarballUrl ? [release.tarballUrl] : []);
      await downloadFile(downloadUrls.length ? downloadUrls : release.tarballUrl, tarball, {
        signal: this.abort.signal,
        timeoutMs: 600000,
        onProgress: (p) => this.step('download', 'running', `Downloading Nimbus Drive ${release.version}…`, { progress: p.percent }),
      });
      this.step('download', 'ok', `Downloaded ${release.version}`);

      // 2 — unpack (GitHub tarballs wrap everything in one top-level folder)
      this.step('extract', 'running', 'Unpacking…');
      await extractArchive(tarball, staging, { stripComponents: 1 });
      await fsp.rm(tarball, { force: true }).catch(() => {});
      if (!fs.existsSync(path.join(staging, 'server', 'src', 'index.js'))) {
        throw new Error('The downloaded code does not look like Nimbus Drive (server/src/index.js missing).');
      }
      this.step('extract', 'ok', 'Unpacked');

      // Config first: the web build bakes the API port from .env, so it must
      // be in place BEFORE building.
      await this.materializeEnv(staging);

      // 3 — dependencies (server: runtime only; web: full, the build needs dev deps)
      // --no-package-lock is deliberate: lockfile-driven installs lose packages'
      // "gypfile: false" marker, which makes npm try a from-source C++ build of
      // better-sqlite3 — guaranteed to fail on PCs without a compiler. Manifest
      // installs use the bundled prebuilds. (Versions are pinned by the release
      // tag itself.)
      const npmFlags = ['install', '--no-package-lock', '--no-audit', '--no-fund'];
      this.step('deps', 'running', 'Installing server components…');
      await this._npm('deps', [...npmFlags, '--omit=dev'], path.join(staging, 'server'));
      this.step('deps', 'running', 'Installing web components… (this is the slow one)');
      await this._npm('deps', npmFlags, path.join(staging, 'web'));
      this.step('deps', 'ok', 'Components installed');

      // 4 — build the web app
      this.step('build', 'running', 'Building the web app…');
      const nextBin = path.join(staging, 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
      await this._spawnLogged('build', this.runtime.nodeBin, [nextBin, 'build'], {
        cwd: path.join(staging, 'web'),
        env: { NODE_ENV: 'production' },
      });
      if (!fs.existsSync(path.join(staging, 'web', '.next', 'BUILD_ID'))) {
        throw new Error('Build finished but produced no output — see the install log.');
      }
      this.step('build', 'ok', 'Web app built');

      // 5 — activate (atomic-ish: rename, then repoint current.json)
      this.step('activate', 'running', 'Activating…');
      await fsp.writeFile(
        path.join(staging, '.nimbus-version.json'),
        JSON.stringify({ version: release.version, name: release.name || release.version, notes: release.notes || '', installedAt: Date.now() }, null, 2)
      );
      await this.retire(finalDir); // move any previous copy aside (instant)
      await safeMoveDir(staging, finalDir);
      await fsp.writeFile(this.currentFile, JSON.stringify({ version: release.version, path: finalDir, activatedAt: Date.now() }, null, 2));
      this.step('activate', 'ok', `Nimbus Drive ${release.version} is ready`);
      // Old versions are cleaned up AFTER the user is running — deleting
      // node_modules trees is slow and must never hold up activation.
      this.prune().catch(() => {});
      return { version: release.version, path: finalDir };
    } catch (err) {
      const msg = this.abort.signal.aborted ? 'Cancelled' : err.message;
      this.step('error', 'fail', msg);
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(tarball, { force: true }).catch(() => {});
      throw new Error(msg);
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  /** Roll back to the most recent non-active version. */
  async rollback() {
    const prev = this.previous();
    if (!prev) throw new Error('No previous version to roll back to.');
    await this.materializeEnv(prev.path);
    await fsp.writeFile(this.currentFile, JSON.stringify({ version: prev.version, path: prev.path, activatedAt: Date.now() }, null, 2));
    return { version: prev.version, path: prev.path };
  }

  /** Delete all non-active version directories, staging folders, and downloaded archives. */
  /** Folder where retired versions wait to be deleted (same volume = instant move). */
  trashDir() {
    return path.join(this.versionsDir, '.trash');
  }

  /**
   * Retire a directory WITHOUT waiting for the delete. Deleting a version means
   * removing tens of thousands of node_modules files, which on Windows (with
   * Defender scanning each one) takes minutes — far too slow to sit inside the
   * "Activating" step. Renaming it aside is instantaneous; the actual delete
   * happens in the background.
   */
  async retire(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    try {
      await fsp.mkdir(this.trashDir(), { recursive: true });
      const dest = path.join(this.trashDir(), `${path.basename(dir)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      await fsp.rename(dir, dest); // instant on the same volume
      this.deleteInBackground(dest);
    } catch {
      // locked or cross-volume — fall back to a background delete in place
      this.deleteInBackground(dir);
    }
  }

  /** Fire-and-forget removal; never blocks the UI and never throws. */
  deleteInBackground(target) {
    const timer = setTimeout(() => {
      fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    }, 0);
    if (timer.unref) timer.unref();
  }

  /** Empty the trash folder in the background (called at startup too). */
  sweepTrash() {
    try {
      if (!fs.existsSync(this.trashDir())) return;
      for (const name of fs.readdirSync(this.trashDir())) {
        this.deleteInBackground(path.join(this.trashDir(), name));
      }
    } catch { /* best effort */ }
  }

  async prune() {
    const cur = this.current();
    if (!cur || !cur.path) return;
    // Keep the running version AND the one before it, so "Roll back" stays possible.
    const keep = new Set([path.resolve(cur.path), this.previous() ? path.resolve(this.previous().path) : null].filter(Boolean));
    try {
      if (!fs.existsSync(this.versionsDir)) return;
      for (const entry of await fsp.readdir(this.versionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const fullPath = path.resolve(this.versionsDir, entry.name);
        if (keep.has(fullPath)) continue;
        await this.retire(fullPath); // instant move-aside + background delete
      }
    } catch { /* best effort */ }
    this.sweepTrash();
  }

  /** Rebuild the ACTIVE version's web app (needed when API_PORT changes). */
  async rebuildActive() {
    const cur = this.current();
    if (!cur) throw new Error('Nothing installed yet.');
    await this.materializeEnv(cur.path);
    this.step('build', 'running', 'Rebuilding the web app…');
    const nextBin = path.join(cur.path, 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
    await this._spawnLogged('build', this.runtime.nodeBin, [nextBin, 'build'], {
      cwd: path.join(cur.path, 'web'),
      env: { NODE_ENV: 'production' },
    });
    this.step('build', 'ok', 'Web app rebuilt');
  }

  /** Is `latest` newer than what's installed? (string compare on tags is unsafe → compare identity) */
  updateAvailable(latest) {
    const cur = this.current();
    if (!cur) return true;
    return sanitizeVersion(latest.version) !== sanitizeVersion(cur.version);
  }

  cancel() {
    this.abort?.abort(new Error('cancelled'));
    for (const c of this.children) {
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  /** Which API_PORT is baked into a version's build (null = unknown). */
  bakedApiPort(versionDir) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(versionDir, 'web', '.next', 'routes-manifest.json'), 'utf8'));
      for (const rw of manifest.rewrites?.afterFiles || manifest.rewrites || []) {
        const m = /:\/\/[^:]+:(\d+)\/api/.exec(rw.destination || '');
        if (m) return Number(m[1]);
      }
    } catch { /* ignore */ }
    return null;
  }

  /** Does the active build's baked port disagree with .env? → rebuild needed. */
  needsRebuild() {
    const cur = this.current();
    if (!cur) return false;
    const baked = this.bakedApiPort(cur.path);
    if (!baked) return false;
    const env = readEnv(path.join(cur.path, '.env')) || readEnv(this.canonicalEnvPath()) || {};
    return Number(env.API_PORT || 4400) !== baked;
  }
}

module.exports = { Bootstrap };
