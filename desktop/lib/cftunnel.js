'use strict';
/**
 * Cloudflare tunnel management, driven from the app instead of a terminal.
 *
 * Everything the SETUP.md walkthrough used to ask people to type by hand —
 * downloading cloudflared, authorizing the Cloudflare account in a browser,
 * creating a tunnel, pointing a DNS record at it, writing config.yml — runs
 * here, one step at a time, reporting progress the UI can display.
 *
 * The cloudflared CLI is the only source of truth: no Cloudflare API tokens are
 * handled, stored, or transmitted by this module. Authorization happens in the
 * user's own browser, and cloudflared writes the resulting cert.pem itself.
 *
 * Every function takes an explicit `bin` and `home` so the whole flow can be
 * exercised against a stand-in cloudflared in tests.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { certPath, cfDir, hasLogin, findCredentials, ensureNamedConfig, hostnameFromBaseUrl, configPath } = require('./cfconfig');

const DEFAULT_TIMEOUT_MS = 60000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

class CloudflaredError extends Error {
  constructor(message, { code, stdout, stderr, args } = {}) {
    super(message);
    this.name = 'CloudflaredError';
    this.code = code; this.stdout = stdout; this.stderr = stderr; this.args = args;
  }
}

/** Run a cloudflared subcommand to completion. Never throws on non-zero — the caller decides. */
function run(bin, args, { home, timeoutMs = DEFAULT_TIMEOUT_MS, signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    let child;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        env: {
          ...process.env,
          // keep cloudflared's state inside the home we were handed, so tests
          // (and portable installs) never touch the real ~/.cloudflared
          ...(home ? { TUNNEL_ORIGIN_CERT: certPath(home) } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return reject(new CloudflaredError(`Could not run cloudflared: ${err.message}`, { args }));
    }
    let stdout = '', stderr = '', settled = false;
    const push = (buf, into) => {
      const text = String(buf);
      if (into === 'out') stdout += text; else stderr += text;
      if (onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', (d) => push(d, 'out'));
    child.stderr.on('data', (d) => push(d, 'err'));

    const finish = (fn, arg) => { if (settled) return; settled = true; cleanup(); fn(arg); };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new CloudflaredError(`cloudflared ${args[0] || ''} timed out after ${Math.round(timeoutMs / 1000)}s`, { stdout, stderr, args }));
    }, timeoutMs);
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new Error('cancelled'));
    };
    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => finish(reject, new CloudflaredError(`Could not run cloudflared: ${err.message}`, { args })));
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
  });
}

const trimErr = (r) => (r.stderr || r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' ').trim();

/** Tunnels this account owns, as cloudflared reports them. */
async function listTunnels({ bin, home, signal } = {}) {
  const r = await run(bin, ['tunnel', 'list', '--output', 'json'], { home, signal });
  if (r.code !== 0) throw new CloudflaredError(`Could not list tunnels: ${trimErr(r)}`, r);
  let raw;
  try { raw = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => ({
    id: t.id || t.ID || '',
    name: t.name || t.Name || '',
    connections: Array.isArray(t.connections) ? t.connections.length : 0,
  })).filter((t) => UUID_RE.test(t.id));
}

async function findTunnelByName({ bin, home, name, signal }) {
  const all = await listTunnels({ bin, home, signal });
  const want = String(name || '').trim().toLowerCase();
  return all.find((t) => t.name.toLowerCase() === want) || null;
}

/** Create a tunnel and return { id, credentialsFile }. */
async function createTunnel({ bin, home, name, signal }) {
  const credentialsFile = path.join(cfDir(home), `${name}.json`);
  const r = await run(bin, ['tunnel', 'create', '--output', 'json', '--credentials-file', credentialsFile, name], { home, signal });
  if (r.code !== 0) {
    const msg = trimErr(r);
    if (/already exists/i.test(msg)) {
      const found = await findTunnelByName({ bin, home, name, signal });
      if (found) return { id: found.id, credentialsFile, reused: true, hasCredentials: fs.existsSync(credentialsFile) };
    }
    throw new CloudflaredError(`Could not create the tunnel: ${msg}`, r);
  }
  // json output is preferred; fall back to scraping the id out of the text
  let id = '';
  try {
    const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    id = parsed.id || parsed.ID || '';
  } catch { /* fall through */ }
  if (!UUID_RE.test(id)) id = (UUID_RE.exec(r.stdout) || UUID_RE.exec(r.stderr) || [''])[0];
  if (!UUID_RE.test(id)) {
    const found = await findTunnelByName({ bin, home, name, signal });
    if (found) id = found.id;
  }
  if (!UUID_RE.test(id)) throw new CloudflaredError('The tunnel was created but its id could not be read.', r);
  return { id, credentialsFile, reused: false };
}

/**
 * Point a hostname at the tunnel.
 * @returns {{ok:true}} | {{ok:false, reason:'exists', message:string}}
 */
async function routeDns({ bin, home, name, hostname, overwrite = false, signal }) {
  const args = ['tunnel', 'route', 'dns'];
  if (overwrite) args.push('--overwrite-dns');
  args.push(name, hostname);
  const r = await run(bin, args, { home, signal });
  if (r.code === 0) return { ok: true };
  const msg = trimErr(r);
  // an existing record is a question for the user, not a failure
  if (/already exists|record with that host|failed to add route.*exists/i.test(msg)) {
    return { ok: false, reason: 'exists', message: msg };
  }
  throw new CloudflaredError(`Could not point ${hostname} at the tunnel: ${msg}`, r);
}

async function deleteTunnel({ bin, home, name, force = true, signal }) {
  const args = ['tunnel', 'delete'];
  if (force) args.push('--force');
  args.push(name);
  const r = await run(bin, args, { home, signal });
  if (r.code !== 0) throw new CloudflaredError(`Could not delete the tunnel: ${trimErr(r)}`, r);
  return { ok: true };
}

/**
 * Authorize this PC against a Cloudflare account.
 *
 * cloudflared prints a one-time URL and waits; the user picks their domain in
 * the browser and cloudflared writes cert.pem. `onUrl` is how the caller opens
 * that page (Electron's shell.openExternal) instead of asking the user to copy
 * it out of a log.
 */
async function login({ bin, home, onUrl, onLine, signal, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  let sent = false;
  const r = await run(bin, ['tunnel', 'login'], {
    home,
    timeoutMs,
    signal,
    onLine: (line) => {
      if (onLine) onLine(line);
      if (sent) return;
      const url = (/(https:\/\/\S+)/.exec(line) || [])[1];
      // the auth page is the only https URL cloudflared prints before it blocks
      if (url && /cloudflare/i.test(url)) { sent = true; try { onUrl && onUrl(url.replace(/[).,]+$/, '')); } catch { /* caller's problem */ } }
    },
  });
  if (!hasLogin(home)) {
    const why = trimErr(r) || 'the browser step was not completed';
    throw new CloudflaredError(`Cloudflare authorization did not finish — ${why}`, r);
  }
  return { ok: true, certPath: certPath(home) };
}

/**
 * What this machine currently has. Safe to call at any time; never mutates.
 */
async function status({ bin, home, baseUrl, tunnelName, signal } = {}) {
  const out = {
    installed: !!bin,
    linked: hasLogin(home),
    credentials: findCredentials(home).map((c) => ({ id: c.id, name: c.name })),
    configPath: configPath(home),
    hasConfig: fs.existsSync(configPath(home)),
    hostname: hostnameFromBaseUrl(baseUrl),
    tunnels: null,
    tunnelsError: null,
  };
  if (out.installed && out.linked) {
    try { out.tunnels = await listTunnels({ bin, home, signal }); }
    catch (err) { out.tunnelsError = err.message; }
  }
  out.ready = !!(out.installed && out.linked && out.hasConfig);
  out.match = out.tunnels && tunnelName
    ? out.tunnels.find((t) => t.name.toLowerCase() === String(tunnelName).toLowerCase()) || null
    : null;
  return out;
}

/**
 * The whole named-tunnel setup, start to finish.
 *
 * @param {(evt:{step:string,status:'running'|'ok'|'fail'|'action',detail?:string,url?:string})=>void} onStep
 * @returns {{ok:true, tunnelId:string, hostname:string, configPath:string, dns:'created'|'exists'|'overwritten'}}
 */
async function setup({ bin, home, name = 'nimbus', hostname, port = 3000, overwriteDns = false, recreate = false, onStep = () => {}, signal } = {}) {
  const step = (s, status, detail, extra = {}) => onStep({ step: s, status, detail, ...extra });
  if (!bin) throw new CloudflaredError('cloudflared is not installed yet.');
  if (!hostname) throw new CloudflaredError('A public domain is required. Set BASE_URL in Settings to the address family will use, for example https://cloud.example.com.');

  // 1 — authorize this PC (skipped when cert.pem is already here)
  if (hasLogin(home)) {
    step('link', 'ok', 'This PC is already linked to your Cloudflare account.');
  } else {
    step('link', 'running', 'Opening Cloudflare in your browser — pick the domain you want to use…');
    await login({
      bin, home, signal,
      onUrl: (url) => step('link', 'action', 'Authorize Nimbus Drive in the browser window that just opened.', { url }),
    });
    step('link', 'ok', 'Cloudflare account linked.');
  }

  // 2 — the tunnel itself
  step('tunnel', 'running', `Looking for a tunnel named "${name}"…`);
  let tunnel = await findTunnelByName({ bin, home, name, signal });

  // A tunnel can exist in the Cloudflare account while THIS PC has no
  // credentials for it — created on another machine, or the file was deleted.
  // Cloudflare only reveals a tunnel's secret at creation time, so there is no
  // way to re-download it: the tunnel has to be recreated, or left alone.
  const hasLocalCreds = (id) => findCredentials(home).some((c) => c.id === id);
  if (tunnel && !hasLocalCreds(tunnel.id)) {
    if (!recreate) {
      step('tunnel', 'fail',
        `The tunnel "${name}" exists in your Cloudflare account, but this PC does not have its credentials file, ` +
        `and Cloudflare only issues that once — at creation. Choose "Recreate the tunnel on this PC" to replace it, ` +
        `use a different tunnel name, or switch to a tunnel token.`);
      const err = new CloudflaredError(
        `The tunnel "${name}" exists in your Cloudflare account but its credentials file is not on this PC. ` +
        `Recreate it here, pick another name, or use a tunnel token instead.`);
      err.needsRecreate = true;
      err.tunnelId = tunnel.id;
      throw err;
    }
    step('tunnel', 'running', `Replacing the tunnel "${name}" so this PC owns its credentials…`);
    await deleteTunnel({ bin, home, name, force: true, signal });
    tunnel = null;
  }

  if (tunnel) {
    step('tunnel', 'ok', `Using the existing tunnel "${name}" (${tunnel.id}).`);
  } else {
    const made = await createTunnel({ bin, home, name, signal });
    tunnel = { id: made.id, name };
    step('tunnel', 'ok', `${recreate ? 'Recreated' : 'Created'} the tunnel "${name}" (${made.id}).`);
  }

  // 3 — DNS
  step('dns', 'running', `Pointing ${hostname} at the tunnel…`);
  let dns = 'created';
  // always try WITHOUT --overwrite-dns first: forcing when nothing is in the way
  // would report a replacement that never happened, and forcing blindly is how
  // an unrelated record gets clobbered
  const routed = await routeDns({ bin, home, name, hostname, overwrite: false, signal });
  if (!routed.ok && routed.reason === 'exists') {
    if (!overwriteDns) {
      step('dns', 'fail', `${hostname} already points somewhere else. Re-run with "Replace the existing DNS record" to take it over.`);
      const err = new CloudflaredError(`${hostname} already has a DNS record pointing elsewhere.`);
      err.needsOverwrite = true;
      throw err;
    }
    await routeDns({ bin, home, name, hostname, overwrite: true, signal });
    dns = 'overwritten';
  }
  step('dns', 'ok', dns === 'overwritten' ? `${hostname} now points at the tunnel (previous record replaced).` : `${hostname} now points at the tunnel.`);

  // 4 — the routing file cloudflared reads at run time
  step('config', 'running', 'Writing the tunnel configuration…');
  const made = ensureNamedConfig({ home, baseUrl: `https://${hostname}`, port, tunnelName: name, ignoreExisting: true });
  if (!made.path) {
    const err = new CloudflaredError(`The tunnel is ready but its configuration could not be written (${made.reason}).`);
    step('config', 'fail', err.message);
    throw err;
  }
  step('config', 'ok', `Configuration written to ${made.path}.`);
  return { ok: true, tunnelId: tunnel.id, hostname, configPath: made.path, dns, replaced: made.replaced || null };
}

module.exports = {
  run, listTunnels, findTunnelByName, createTunnel, routeDns, deleteTunnel,
  login, status, setup, CloudflaredError, LOGIN_TIMEOUT_MS,
};
