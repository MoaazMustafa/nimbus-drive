'use strict';
/**
 * ManagedProcess — one supervised child process with:
 *  - stdout/stderr capture into a LogBuffer
 *  - automatic restart with exponential backoff on crash
 *  - crash-loop detection (too many restarts in a window -> 'failed' + alert)
 *  - graceful stop (SIGTERM, then kill; process-tree kill on Windows)
 */
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10000, 30000];

class ManagedProcess extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.name            display name ("api", "web", "tunnel")
   * @param {() => {cmd:string,args:string[],cwd:string,env?:object}} opts.getSpec
   * @param {import('./logbuf').LogBuffer} opts.log
   * @param {number[]} [opts.backoff]     restart delays (ms)
   * @param {number}  [opts.maxRestarts]  restarts allowed inside windowMs before failing
   * @param {number}  [opts.windowMs]
   */
  constructor({ name, getSpec, log, backoff = DEFAULT_BACKOFF, maxRestarts = 5, windowMs = 60000 }) {
    super();
    this.name = name;
    this.getSpec = getSpec;
    this.log = log;
    this.backoff = backoff;
    this.maxRestarts = maxRestarts;
    this.windowMs = windowMs;

    this.child = null;
    this.status = 'stopped'; // stopped | starting | online | backoff | failed
    this.desired = 'stopped'; // stopped | running
    this.pid = null;
    this.startedAt = null;
    this.restartTimes = [];
    this.restartTimer = null;
    this.lastExit = null; // {code, signal, at}
    this.lastError = null;
    this.recentErr = []; // last few stderr lines — the "why" behind a crash
  }

  setStatus(status, extra = {}) {
    if (this.status !== status) {
      this.status = status;
      this.emit('status', { name: this.name, status, ...extra });
    }
  }

  start() {
    this.desired = 'running';
    this.lastError = null;
    this.restartTimes = [];
    this._spawn();
  }

  _spawn() {
    if (this.child || this.desired !== 'running') return;
    let spec;
    try {
      spec = this.getSpec();
    } catch (err) {
      this.lastError = err.message;
      this.log.push(`[supervisor] cannot start ${this.name}: ${err.message}`, 'error');
      this.setStatus('failed');
      return;
    }
    this.setStatus('starting');
    this.recentErr = [];
    this.log.push(`[supervisor] starting: ${spec.cmd} ${spec.args.join(' ')}`);
    let child;
    try {
      child = spawn(spec.cmd, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this._onSpawnError(err);
      return;
    }
    this.child = child;
    this.pid = child.pid || null;
    this.startedAt = Date.now();
    child.stdout.on('data', (d) => this.log.push(d.toString()));
    child.stderr.on('data', (d) => {
      const text = d.toString();
      this.log.push(text, 'error');
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        // keep the meaningful complaint, not usage/help boilerplate
        if (!t || /^(NAME|USAGE|DESCRIPTION|OPTIONS|SUBCOMMAND|TUNNEL COMMAND|GLOBAL)/i.test(t) || t.startsWith('--')) continue;
        this.recentErr.push(t);
        if (this.recentErr.length > 5) this.recentErr.shift();
      }
    });
    child.once('error', (err) => this._onSpawnError(err));
    child.once('exit', (code, signal) => this._onExit(code, signal));
  }

  _onSpawnError(err) {
    this.child = null;
    this.pid = null;
    if (err && err.code === 'ENOENT') {
      this.lastError = `Command not found: ${err.path || ''}`.trim();
    } else {
      this.lastError = err ? err.message : 'spawn failed';
    }
    this.log.push(`[supervisor] ${this.name} failed to start: ${this.lastError}`, 'error');
    this.setStatus('failed');
    this.emit('failed', { name: this.name, error: this.lastError });
  }

  _onExit(code, signal) {
    this.child = null;
    const wasPid = this.pid;
    this.pid = null;
    this.lastExit = { code, signal, at: Date.now() };
    if (this.desired !== 'running') {
      this.log.push(`[supervisor] ${this.name} stopped (pid ${wasPid})`);
      this.setStatus('stopped');
      return;
    }
    const reason = this.recentErr.filter(Boolean).slice(-2).join(' — ');
    if (reason) this.lastError = reason;
    this.log.push(`[supervisor] ${this.name} exited unexpectedly (code=${code} signal=${signal || 'none'})${reason ? ` — ${reason}` : ''}`, 'error');
    // crash-loop detection
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < this.windowMs);
    this.restartTimes.push(now);
    if (this.restartTimes.length > this.maxRestarts) {
      const why = this.recentErr.filter(Boolean).slice(-2).join(' — ');
      this.lastError = why
        ? `${why}  (gave up after ${this.restartTimes.length} attempts — see the ${this.name} log)`
        : `Crashed ${this.restartTimes.length} times in ${Math.round(this.windowMs / 1000)}s — giving up. Check the ${this.name} logs.`;
      this.log.push(`[supervisor] ${this.lastError}`, 'error');
      this.setStatus('failed');
      this.emit('failed', { name: this.name, error: this.lastError });
      return;
    }
    const delay = this.backoff[Math.min(this.restartTimes.length - 1, this.backoff.length - 1)];
    this.setStatus('backoff');
    this.log.push(`[supervisor] restarting ${this.name} in ${Math.round(delay / 1000)}s (attempt ${this.restartTimes.length}/${this.maxRestarts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._spawn();
    }, delay);
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  markOnline() {
    if (this.status === 'starting' || this.status === 'backoff') {
      // a period of sustained health clears the crash counter
      this.restartTimes = [];
    }
    if (this.child) this.setStatus('online');
  }

  markUnhealthy() {
    if (this.status === 'online') this.setStatus('starting');
  }

  async stop({ timeoutMs = 6000 } = {}) {
    this.desired = 'stopped';
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) {
      this.setStatus('stopped');
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    if (process.platform === 'win32') {
      // Kill the whole tree (next/node spawn workers) — SIGTERM is unreliable on Windows.
      await new Promise((resolve) => {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      });
    } else {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs).unref());
    await Promise.race([exited, timeout]);
    if (this.child) {
      try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000).unref())]);
    }
    this.setStatus('stopped');
  }

  snapshot() {
    return {
      name: this.name,
      status: this.status,
      pid: this.pid,
      uptimeMs: this.child && this.startedAt ? Date.now() - this.startedAt : 0,
      restarts: this.restartTimes.length,
      lastExit: this.lastExit,
      lastError: this.lastError,
    };
  }
}

module.exports = { ManagedProcess, DEFAULT_BACKOFF };
