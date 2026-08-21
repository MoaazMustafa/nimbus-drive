#!/usr/bin/env node
/**
 * A tiny fake of Google's OAuth endpoints, for developing and testing WITHOUT
 * real Google credentials. Never used in production — the real server only
 * talks to accounts.google.com unless you explicitly override
 * GOOGLE_AUTHORIZE_URL / GOOGLE_TOKEN_URL / GOOGLE_USERINFO_URL in the .env.
 *
 * The "account picker" is just ?login_hint=<email> on the authorize URL.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_GOOGLE_PORT || 5599);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/auth') {
    const redirect = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const email = url.searchParams.get('login_hint') || 'tester@example.com';
    const code = Buffer.from(email).toString('base64url');
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);
    res.writeHead(302, { Location: back.toString() });
    res.end();
    return;
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const code = params.get('code') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: code, token_type: 'Bearer', expires_in: 3600 }));
    return;
  }

  if (url.pathname === '/userinfo') {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    let email = 'tester@example.com';
    try {
      email = Buffer.from(token, 'base64url').toString('utf8') || email;
    } catch {
      /* keep default */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sub: `mock-${email}`,
        email,
        email_verified: true,
        name: email.split('@')[0].replace(/\b\w/g, (c) => c.toUpperCase()),
        picture: '',
      })
    );
    return;
  }

  res.writeHead(404);
  res.end('mock-google: unknown path');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-google] listening on http://127.0.0.1:${PORT}  (auth /auth, token /token, userinfo /userinfo)`);
});
