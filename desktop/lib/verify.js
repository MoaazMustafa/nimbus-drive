'use strict';
/**
 * Domain & sign-in verifier — answers, with evidence, two questions a family
 * host actually cares about:
 *
 *   1. "Is my drive really live on MY domain?"  (tunnel → this machine)
 *   2. "Can people actually sign in from a browser?"  (Google OAuth accepts us)
 *
 * Every check returns a status plus a concrete fix, so a failure tells the user
 * what to do rather than just that something is wrong. Network/DNS access is
 * injectable so the whole chain is testable offline.
 */
const path = require('node:path');
const fs = require('node:fs');
const dnsPromises = require('node:dns').promises;

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';
const SKIP = 'skip';

const r = (id, label, status, detail, fix) => ({ id, label, status, detail, fix: fix || null });

async function probe(fetchImpl, url, { ms = 9000, redirect = 'follow' } = {}) {
  try {
    const res = await fetchImpl(url, {
      redirect,
      signal: AbortSignal.timeout(ms),
      headers: { 'User-Agent': 'nimbus-desktop-verify' },
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json, location: res.headers.get('location'), url: res.url };
  } catch (err) {
    return { status: 0, error: String(err.message || err), text: '', json: null };
  }
}

/** Read the cloudflared config that would route this hostname. */
function readTunnelConfig({ projectRoot, homeDir }) {
  const candidates = [
    projectRoot && path.join(projectRoot, 'cloudflared', 'config.yml'),
    homeDir && path.join(homeDir, '.cloudflared', 'config.yml'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.cloudflared', 'config.yml'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      const hosts = [...txt.matchAll(/hostname:\s*(\S+)/g)].map((m) => m[1]);
      const services = [...txt.matchAll(/service:\s*https?:\/\/[^:\s]+:(\d+)/g)].map((m) => Number(m[1]));
      return { file, hosts, services, text: txt };
    } catch { /* next candidate */ }
  }
  return null;
}

/**
 * @returns {{overall:'ok'|'warn'|'fail', checks:Array, publicUrl:string|null, redirectUri:string|null}}
 */
async function runDiagnostics(opts = {}) {
  const {
    env = {},
    apiPort,
    webPort,
    tunnelEnabled = false,
    tunnelMode = 'named',
    projectRoot = null,
    homeDir = null,
    fetchImpl = fetch,
    dns = dnsPromises,
  } = opts;

  const checks = [];
  const baseRaw = String(env.BASE_URL || '').replace(/\/+$/, '');
  let base = null;
  try { base = new URL(baseRaw); } catch { /* invalid */ }
  const redirect = baseRaw ? `${baseRaw}/api/auth/callback/google` : null;
  const isLocal = !!base && ['localhost', '127.0.0.1'].includes(base.hostname);
  const isPublic = !!base && !isLocal;

  // 1 ── address configuration
  if (!base) {
    checks.push(r('config', 'Drive address', FAIL, `BASE_URL is not a valid URL ("${baseRaw}")`,
      'Set Base URL in Settings to your domain, e.g. https://cloud.example.com'));
  } else if (isLocal) {
    checks.push(r('config', 'Drive address', WARN, `${baseRaw} — local only, nobody outside this PC can reach it`,
      'To go public, set Base URL to your domain and enable the tunnel.'));
  } else if (base.protocol !== 'https:') {
    checks.push(r('config', 'Drive address', FAIL, `${baseRaw} uses http — Google sign-in and secure cookies need https`,
      'Change Base URL to https://' + base.hostname));
  } else {
    checks.push(r('config', 'Drive address', OK, baseRaw));
  }

  // 2 ── the drive itself, locally
  const api = apiPort ? await probe(fetchImpl, `http://127.0.0.1:${apiPort}/api/health`, { ms: 4000 }) : { status: 0, error: 'no port' };
  const apiOk = api.json?.ok === true;
  checks.push(apiOk
    ? r('local-api', 'Drive engine (this PC)', OK, `healthy on port ${apiPort}`)
    : r('local-api', 'Drive engine (this PC)', FAIL, api.error || `port ${apiPort} returned ${api.status}`,
        'Press Start in the control panel; if it keeps failing, open the Logs tab (API).'));

  const web = webPort ? await probe(fetchImpl, `http://127.0.0.1:${webPort}/api/health`, { ms: 6000 }) : { status: 0, error: 'no port' };
  const webOk = web.json?.ok === true;
  checks.push(webOk
    ? r('local-web', 'Website (this PC)', OK, `serving on port ${webPort}, reaching the engine`)
    : r('local-web', 'Website (this PC)', FAIL, web.error || `port ${webPort} returned ${web.status}`,
        webOk === false && apiOk
          ? 'The website is up but cannot reach the engine — restart from the control panel.'
          : 'Press Start in the control panel and watch the Logs tab (Web).'));

  if (!isPublic) {
    checks.push(r('public', 'Reachable from the internet', SKIP, 'skipped — this drive is set up for local use only'));
    return finish(checks, baseRaw || null, redirect);
  }

  // 3 ── quick tunnels can never serve a custom domain
  if (tunnelEnabled && tunnelMode === 'quick') {
    checks.push(r('tunnel-mode', 'Tunnel mode', FAIL,
      'Quick Tunnel is selected — it produces a random trycloudflare.com address that changes on every restart, so it will never serve ' + base.hostname,
      'In Settings choose the "named tunnel" mode (your domain), or turn the tunnel off here and let the cloudflared Windows service run it.'));
  }

  // 4 ── does the DNS name exist at all?
  let dnsOk = false;
  try {
    const addrs = await dns.resolve(base.hostname);
    dnsOk = Array.isArray(addrs) && addrs.length > 0;
    checks.push(r('dns', 'Domain name', OK, `${base.hostname} resolves (${addrs.slice(0, 2).join(', ')})`));
  } catch (err) {
    checks.push(r('dns', 'Domain name', FAIL, `${base.hostname} does not resolve (${err.code || err.message})`,
      'In the Cloudflare dashboard add a DNS record for this hostname pointing at your tunnel (CNAME → <tunnel-id>.cfargotunnel.com, proxied).'));
  }

  // 5 ── routing: does the tunnel config actually carry THIS hostname to THIS port?
  const cfg = tunnelMode === 'token' ? null : readTunnelConfig({ projectRoot, homeDir });
  if (tunnelMode === 'token') {
    checks.push(r('tunnel-route', 'Tunnel routing', SKIP, 'token mode — routing is configured in the Cloudflare dashboard'));
  } else if (!cfg) {
    checks.push(r('tunnel-route', 'Tunnel routing', WARN, 'no cloudflared config.yml found on this PC',
      'That is fine if cloudflared runs as a Windows service with its own config; otherwise see SETUP.md §5.'));
  } else if (!cfg.hosts.includes(base.hostname)) {
    checks.push(r('tunnel-route', 'Tunnel routing', FAIL,
      `${cfg.file} routes ${cfg.hosts.join(', ') || 'nothing'} — not ${base.hostname}`,
      `Edit that file so the hostname matches your Base URL, then restart the tunnel.`));
  } else if (webPort && cfg.services.length && !cfg.services.includes(Number(webPort))) {
    checks.push(r('tunnel-route', 'Tunnel routing', FAIL,
      `the tunnel sends ${base.hostname} to port ${cfg.services.join('/')} but the website is on port ${webPort}`,
      `Change "service: http://localhost:${cfg.services[0]}" to port ${webPort} in ${cfg.file}, then restart the tunnel.`));
  } else {
    checks.push(r('tunnel-route', 'Tunnel routing', OK, `${base.hostname} → localhost:${webPort} (${path.basename(cfg.file)})`));
  }

  // 6 ── the decisive one: does the public address reach THIS machine?
  const pub = await probe(fetchImpl, `${baseRaw}/api/health`, { ms: 12000 });
  const pubOk = pub.json?.ok === true;
  const sameMachine = pubOk && (!api.json?.app || pub.json.app === api.json.app);
  if (!pubOk) {
    checks.push(r('public', 'Reachable from the internet', FAIL,
      pub.error ? `${baseRaw} — ${pub.error}` : `${baseRaw} returned HTTP ${pub.status}`,
      pub.status === 502 || pub.status === 530
        ? 'Cloudflare reached the tunnel but not the app — make sure the drive is Started and the tunnel points at the right port.'
        : 'Check that the tunnel is running (control panel or the cloudflared service) and that DNS is set up.'));
  } else if (!sameMachine) {
    checks.push(r('public', 'Reachable from the internet', WARN,
      `${baseRaw} answers, but reports "${pub.json.app}" while this PC runs "${api.json?.app}" — the domain may point at a different machine`,
      'Make sure only one machine serves this hostname.'));
  } else {
    checks.push(r('public', 'Reachable from the internet', OK, `${baseRaw} is live and served by THIS PC`));
  }

  // 7 ── sign-in keys present
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    checks.push(r('oauth-keys', 'Google sign-in keys', FAIL, 'Client ID or Secret is missing',
      'Add both in Settings (SETUP.md §2 shows how to create them).'));
    return finish(checks, baseRaw, redirect);
  }
  checks.push(r('oauth-keys', 'Google sign-in keys', OK, 'Client ID and Secret are set'));

  // 8 ── what the live site actually sends a browser to
  let authorizeUrl = null;
  if (pubOk) {
    const start = await probe(fetchImpl, `${baseRaw}/api/auth/google`, { ms: 10000, redirect: 'manual' });
    const loc = start.location || '';
    if (loc.includes('accounts.google.com') || loc.includes('/o/oauth2/')) {
      authorizeUrl = loc;
      let sent = null;
      try { sent = new URL(loc).searchParams.get('redirect_uri'); } catch { /* ignore */ }
      checks.push(sent === redirect
        ? r('oauth-redirect', 'Sign-in hand-off', OK, `sends browsers to Google with the correct return address`)
        : r('oauth-redirect', 'Sign-in hand-off', FAIL,
            `the live site asks Google to return to "${sent}" instead of "${redirect}"`,
            'Base URL and the running server disagree — Save settings again and Restart the drive.'));
    } else {
      checks.push(r('oauth-redirect', 'Sign-in hand-off', FAIL,
        loc ? `/api/auth/google redirected to ${loc}` : `/api/auth/google returned HTTP ${start.status}`,
        'The live site is not offering Google sign-in — check the Google keys in Settings, then Restart.'));
    }
  } else {
    checks.push(r('oauth-redirect', 'Sign-in hand-off', SKIP, 'skipped — the public address is not reachable yet'));
  }

  // 9 ── would Google itself accept that return address? (catches the classic
  //      redirect_uri_mismatch BEFORE a family member hits it in a browser)
  if (authorizeUrl) {
    const g = await probe(fetchImpl, authorizeUrl, { ms: 12000 });
    const body = (g.text || '').toLowerCase();
    if (body.includes('redirect_uri_mismatch')) {
      checks.push(r('oauth-google', 'Google accepts this address', FAIL,
        'Google rejects the return address (redirect_uri_mismatch)',
        `Add exactly this URI to your OAuth client in Google Console → Credentials → Authorized redirect URIs:\n${redirect}`));
    } else if (body.includes('invalid_client') || body.includes('client_id') && body.includes('unauthorized')) {
      checks.push(r('oauth-google', 'Google accepts this address', FAIL,
        'Google rejects the Client ID (invalid_client)',
        'Re-copy the Client ID and Secret from Google Console into Settings.'));
    } else if (g.status === 0) {
      checks.push(r('oauth-google', 'Google accepts this address', WARN, `could not reach Google (${g.error})`,
        'Check this PC\'s internet connection.'));
    } else {
      checks.push(r('oauth-google', 'Google accepts this address', OK,
        'Google shows the sign-in screen — browser sign-in will work'));
    }
  } else {
    checks.push(r('oauth-google', 'Google accepts this address', SKIP, 'skipped — no sign-in hand-off to test'));
  }

  return finish(checks, baseRaw, redirect);
}

function finish(checks, publicUrl, redirectUri) {
  const overall = checks.some((c) => c.status === FAIL) ? FAIL
    : checks.some((c) => c.status === WARN) ? WARN : OK;
  return { overall, checks, publicUrl, redirectUri };
}

module.exports = { runDiagnostics, readTunnelConfig };
