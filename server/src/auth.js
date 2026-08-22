import { Router } from 'express';
import config from './config.js';
import { httpError, randomToken, wrap, clientIp } from './util.js';
import {
  createSession,
  deleteSession,
  getSession,
  upsertUser,
  isAdminEmail,
  isAuthorizedEmail,
  canBrowseEmail,
  logActivity,
} from './db.js';

const SID_COOKIE = 'nimbus_sid';
const STATE_COOKIE = 'nimbus_oauth';

/** Tiny, dependency-free cookie helpers (predictable on every platform). */
function serializeCookie(name, value, maxAgeSec) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (config.isHttps) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || out[k] !== undefined) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function redirectUri() {
  return `${config.baseUrl}/api/auth/callback/google`;
}

/** Attach req.user if a valid session cookie is present. Never throws. */
export function attachUser(req, _res, next) {
  const sid = parseCookies(req)[SID_COOKIE];
  const session = getSession(sid);
  if (session && isAuthorizedEmail(session.email)) {
    req.sessionId = sid;
    req.user = {
      email: session.email,
      isAdmin: isAdminEmail(session.email),
      canBrowse: canBrowseEmail(session.email),
    };
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) throw httpError(401, 'Sign in required');
  next();
}
// Every authorized user can browse the whole drive, so this is just "signed in".
export function requireBrowse(req, _res, next) {
  if (!req.user) throw httpError(401, 'Sign in required');
  next();
}
export function requireAdmin(req, _res, next) {
  if (!req.user) throw httpError(401, 'Sign in required');
  if (!req.user.isAdmin) throw httpError(403, 'Admin only');
  next();
}

export const authRouter = Router();

authRouter.get('/auth/google', (req, res) => {
  if (!config.google.clientId) {
    return res.redirect(`${config.baseUrl}/login?error=not_configured`);
  }
  const state = randomToken(16);
  const next_ = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
  res.setHeader('Set-Cookie', serializeCookie(STATE_COOKIE, `${state}|${next_}`, 600));
  const url = new URL(config.google.authorizeUrl);
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  res.redirect(url.toString());
});

authRouter.get(
  '/auth/callback/google',
  wrap(async (req, res) => {
    const fail = (code) => res.redirect(`${config.baseUrl}/login?error=${code}`);
    const { code, state } = req.query;
    const stored = parseCookies(req)[STATE_COOKIE] || '';
    const [storedState, next_ = '/'] = stored.split('|');
    // one-time state cookie
    res.setHeader('Set-Cookie', serializeCookie(STATE_COOKIE, '', 0));
    if (!code || !state || !storedState || state !== storedState) return fail('state_mismatch');

    // Exchange the code for tokens
    let tokenJson;
    try {
      const tokenRes = await fetch(config.google.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code),
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) return fail('token_exchange');
      tokenJson = await tokenRes.json();
    } catch {
      return fail('google_unreachable');
    }

    // Fetch the verified profile
    let profile;
    try {
      const uiRes = await fetch(config.google.userinfoUrl, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (!uiRes.ok) return fail('userinfo');
      profile = await uiRes.json();
    } catch {
      return fail('google_unreachable');
    }

    const email = String(profile.email || '').toLowerCase();
    if (!email) return fail('no_email');
    if (profile.email_verified === false || profile.email_verified === 'false') return fail('unverified_email');

    if (!isAuthorizedEmail(email)) {
      logActivity({ email, action: 'login_denied', ip: clientIp(req), detail: 'not on allowlist' });
      return res.redirect(`${config.baseUrl}/login?error=not_authorized&email=${encodeURIComponent(email)}`);
    }

    upsertUser({ email, name: profile.name || email, picture: profile.picture || '' });
    const sid = randomToken(32);
    const ttlMs = config.sessionTtlDays * 24 * 3600 * 1000;
    createSession(sid, email, ttlMs, req.headers['user-agent']);
    logActivity({ email, action: 'login', ip: clientIp(req), detail: (req.headers['user-agent'] || '').slice(0, 200) });
    res.setHeader('Set-Cookie', serializeCookie(SID_COOKIE, sid, config.sessionTtlDays * 24 * 3600));
    res.redirect(`${config.baseUrl}${next_}`);
  })
);

authRouter.post('/auth/logout', (req, res) => {
  const sid = parseCookies(req)[SID_COOKIE];
  if (sid) {
    const s = getSession(sid);
    if (s) logActivity({ email: s.email, action: 'logout', ip: clientIp(req) });
    deleteSession(sid);
  }
  res.setHeader('Set-Cookie', serializeCookie(SID_COOKIE, '', 0));
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) throw httpError(401, 'Sign in required');
  res.json({
    email: req.user.email,
    isAdmin: req.user.isAdmin,
    canBrowse: req.user.canBrowse,
    appName: config.appName,
  });
});
