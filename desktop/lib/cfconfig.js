'use strict';
/**
 * Cloudflare named-tunnel configuration: find it, or build it.
 *
 * A named tunnel needs three things that all live in ~/.cloudflared:
 *   cert.pem                 — account credential, from `cloudflared tunnel login`
 *   <tunnel-uuid>.json       — the tunnel's own credential, from `tunnel create`
 *   config.yml               — routing: which hostname goes to which local port
 *
 * The first two are created by cloudflared. The third was historically left to
 * the user to hand-write, which is where setups died: a config.yml copied from
 * someone else's machine points at a credentials path that does not exist here.
 * Everything needed to write a correct config.yml is already knowable — the
 * tunnel id comes from the credentials file, the hostname from BASE_URL, the
 * port from the running site — so this module writes it instead of asking.
 */
const fs = require('node:fs');
const path = require('node:path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cfDir = (home) => path.join(home, '.cloudflared');
const configPath = (home) => path.join(cfDir(home), 'config.yml');
const certPath = (home) => path.join(cfDir(home), 'cert.pem');

/** Has the machine been through `cloudflared tunnel login`? */
function hasLogin(home) {
  try { return fs.statSync(certPath(home)).size > 0; } catch { return false; }
}

/**
 * Every usable tunnel credentials file in ~/.cloudflared.
 * A tunnel credential is a JSON object with a TunnelSecret and a UUID id; the
 * filename is normally the id, but the id inside the file wins when both exist.
 */
function findCredentials(home) {
  let names = [];
  try { names = fs.readdirSync(cfDir(home)); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!/\.json$/i.test(name)) continue;
    const file = path.join(cfDir(home), name);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!data || typeof data !== 'object') continue;
    const secret = data.TunnelSecret || data.tunnelSecret;
    if (!secret) continue; // e.g. a stray settings file, not a tunnel credential
    const stem = name.replace(/\.json$/i, '');
    const id = String(data.TunnelID || data.tunnelID || (UUID_RE.test(stem) ? stem : ''));
    if (!UUID_RE.test(id)) continue;
    out.push({ id, file, name: data.TunnelName || data.tunnelName || null });
  }
  return out;
}

/** cloud.example.com  ←  https://cloud.example.com/ */
function hostnameFromBaseUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl));
    const h = u.hostname;
    // localhost/127.0.0.1/LAN addresses cannot be routed by a tunnel
    if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || !h.includes('.')) return null;
    return h;
  } catch { return null; }
}

/** The exact file cloudflared will read. Kept tiny and predictable on purpose. */
function renderConfig({ id, credentialsFile, hostname, port }) {
  return [
    '# Written by Nimbus Drive. Safe to edit — the app only rewrites the',
    '# service port to match the site, and never touches anything else.',
    `tunnel: ${id}`,
    `credentials-file: ${credentialsFile}`,
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: http://localhost:${port}`,
    '    originRequest:',
    '      # large uploads and downloads must not be cut off mid-transfer',
    '      connectTimeout: 30s',
    '      noTLSVerify: true',
    '  - service: http_status:404',
    '',
  ].join('\n');
}

/**
 * Resolve the config a named tunnel should run with, creating it when the
 * machine has everything needed.
 *
 * @returns {{path:string, created:boolean, tunnelId?:string}}      on success
 * @returns {{path:null, reason:string, detail?:object}}            when it cannot
 *   reason: 'no-hostname' | 'no-login' | 'no-credentials' | 'ambiguous' | 'write-failed'
 */
function ensureNamedConfig({ home, baseUrl, port, tunnelName, write = true, ignoreExisting = false }) {
  const existing = configPath(home);
  // `ignoreExisting` is how the caller says "I already tried that file and it
  // does not work" — otherwise a broken config.yml would be handed straight
  // back and the same failure would repeat forever.
  if (!ignoreExisting && fs.existsSync(existing)) return { path: existing, created: false };

  // Order matters: "you have no tunnel on this PC" is more useful than "your
  // BASE_URL is not a domain" when in fact neither is set up.
  const creds = findCredentials(home);
  if (creds.length === 0) {
    return { path: null, reason: hasLogin(home) ? 'no-credentials' : 'no-login', detail: { dir: cfDir(home) } };
  }

  const hostname = hostnameFromBaseUrl(baseUrl);
  if (!hostname) return { path: null, reason: 'no-hostname', detail: { baseUrl } };

  // With several tunnels on the machine, the configured name decides. Match on
  // the credential's own TunnelName first, then on the filename stem.
  let chosen = creds[0];
  if (creds.length > 1) {
    const want = String(tunnelName || '').trim().toLowerCase();
    const byName = creds.filter((c) => (c.name || '').toLowerCase() === want);
    if (byName.length === 1) chosen = byName[0];
    else return { path: null, reason: 'ambiguous', detail: { candidates: creds.map((c) => ({ id: c.id, name: c.name })) } };
  }

  const text = renderConfig({ id: chosen.id, credentialsFile: chosen.file, hostname, port });
  if (!write) return { path: existing, created: true, tunnelId: chosen.id, preview: text };
  try {
    fs.mkdirSync(cfDir(home), { recursive: true });
    // never destroy a file the user may have written by hand — park it first
    let replaced = null;
    if (ignoreExisting && fs.existsSync(existing)) {
      replaced = `${existing}.replaced`;
      fs.copyFileSync(existing, replaced);
    }
    fs.writeFileSync(existing, text, 'utf8');
    if (replaced) return { path: existing, created: true, tunnelId: chosen.id, hostname, replaced };
  } catch (err) {
    return { path: null, reason: 'write-failed', detail: { error: err.message, target: existing } };
  }
  return { path: existing, created: true, tunnelId: chosen.id, hostname };
}

/** Human-readable "here is exactly what is missing and what to do". */
function explain(result, { tunnelName = 'nimbus', home = '' } = {}) {
  const d = result.detail || {};
  switch (result.reason) {
    case 'no-hostname':
      return `Named tunnel mode needs a public domain, but BASE_URL is "${d.baseUrl || '(unset)'}".\n` +
        `Set BASE_URL in Settings to the address family will use (for example https://cloud.example.com), then start again.`;
    case 'no-login':
      return `This PC has never been linked to your Cloudflare account, so there is no tunnel to run.\n` +
        `  (nothing usable in ${d.dir || cfDir(home)})\n` +
        `  • Easiest — set Tunnel Mode to "Permanent Custom Domain" in Settings and paste a tunnel token ` +
        `from the Cloudflare dashboard (Networking → Tunnels → Create a tunnel). Nothing else to install.\n` +
        `  • Or link this PC: run "cloudflared tunnel login", then "cloudflared tunnel create ${tunnelName}", ` +
        `then start again — the app writes the config for you.`;
    case 'no-credentials':
      return `This PC is linked to Cloudflare, but no tunnel has been created on it yet.\n` +
        `  (cert.pem is present in ${d.dir || cfDir(home)}, but no <tunnel-id>.json)\n` +
        `Run "cloudflared tunnel create ${tunnelName}" and then "cloudflared tunnel route dns ${tunnelName} <your-domain>", ` +
        `then start again — the app writes ${configPath(home)} for you.\n` +
        `Or switch Tunnel Mode to "Permanent Custom Domain" and paste a tunnel token instead.`;
    case 'ambiguous': {
      const list = (d.candidates || []).map((c) => `    - ${c.name || '(unnamed)'}  ${c.id}`).join('\n');
      return `This PC has several Cloudflare tunnels and none matches the configured name "${tunnelName}":\n${list}\n` +
        `Set "Tunnel name" in Settings to one of the names above, or write ${configPath(home)} yourself.`;
    }
    case 'write-failed':
      return `Could not write the tunnel config to ${d.target} (${d.error}).`;
    default:
      return `The tunnel configuration could not be resolved (${result.reason}).`;
  }
}

module.exports = {
  cfDir, configPath, certPath, hasLogin,
  findCredentials, hostnameFromBaseUrl, renderConfig, ensureNamedConfig, explain,
};
