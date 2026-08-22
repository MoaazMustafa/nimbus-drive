import fs from 'node:fs';
import { Router } from 'express';
import config from '../config.js';
import { httpError, randomToken, wrap, clientIp } from '../util.js';
import { resolveSafe, statOrNull, listDir, kindOf, cleanRel } from '../fsx.js';
import { streamFile, streamZip } from '../stream.js';
import { thumbFor, canThumb } from '../thumbs.js';
import {
  insertLink,
  getLink,
  deleteLink,
  linksForPath,
  linksByCreator,
  allLinks,
  logActivity,
} from '../db.js';

/** View sent to the client for a public link. */
function linkView(s) {
  const name = s.rel_path.split('/').pop() || '/';
  return {
    token: s.token,
    path: s.rel_path,
    name,
    isDir: !!s.is_dir,
    kind: kindOf(name, !!s.is_dir),
    createdBy: s.created_by,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    url: `${config.baseUrl}/l/${s.token}`,
  };
}

/** Resolve `sub` inside a linked folder, never escaping the link target. */
async function resolveLinkTarget(s, sub) {
  const base = resolveSafe(s.rel_path);
  const baseStat = await statOrNull(base.abs);
  if (!baseStat) throw httpError(404, 'This item no longer exists');
  const subRel = cleanRel(sub || '');
  if (!subRel) return { abs: base.abs, rel: base.rel, stat: baseStat };
  if (!baseStat.isDirectory()) throw httpError(400, 'Not a folder link');
  const joined = resolveSafe(`${base.rel}/${subRel}`);
  const st = await statOrNull(joined.abs);
  if (!st) throw httpError(404, 'Not found');
  return { abs: joined.abs, rel: joined.rel, stat: st };
}

// ══════════════════════════════════════════════════════════════════════
// Authenticated management (create / list / delete). Mounted behind auth.
// ══════════════════════════════════════════════════════════════════════
export const linksRouter = Router();

linksRouter.post(
  '/links',
  wrap(async (req, res) => {
    const { path: relIn, expiresDays } = req.body || {};
    const { abs, rel } = resolveSafe(relIn);
    if (!rel) throw httpError(400, 'Cannot share the root folder');
    const st = await statOrNull(abs);
    if (!st) throw httpError(404, 'File not found');

    let expires_at = null;
    if (expiresDays !== undefined && expiresDays !== null && expiresDays !== '') {
      const d = Number(expiresDays);
      if (!Number.isFinite(d) || d <= 0) throw httpError(400, 'Expiry must be a positive number of days');
      expires_at = Date.now() + d * 24 * 3600 * 1000;
    }

    const token = randomToken(12);
    insertLink.run({
      token,
      rel_path: rel,
      is_dir: st.isDirectory() ? 1 : 0,
      created_by: req.user.email,
      created_at: Date.now(),
      expires_at,
    });
    logActivity({ email: req.user.email, action: 'link_create', path: rel, ip: clientIp(req) });
    res.json({ ok: true, link: linkView(getLink(token)) });
  })
);

// Links that exist for one specific path (used by the item's share dialog).
linksRouter.get(
  '/links',
  wrap(async (req, res) => {
    const rel = cleanRel(req.query.path || '');
    if (!rel) return res.json({ links: [] });
    let rows = linksForPath(rel);
    if (!req.user.isAdmin) rows = rows.filter((s) => s.created_by === req.user.email);
    // hide expired
    rows = rows.filter((s) => !s.expires_at || s.expires_at > Date.now());
    res.json({ links: rows.map(linkView) });
  })
);

// All of my links (admins see everyone's) for the "Links" page.
linksRouter.get(
  '/links/mine',
  wrap(async (req, res) => {
    const rows = req.user.isAdmin ? allLinks() : linksByCreator(req.user.email);
    const out = [];
    for (const s of rows) {
      if (s.expires_at && s.expires_at < Date.now()) continue;
      const { abs } = resolveSafe(s.rel_path);
      const exists = !!(await statOrNull(abs));
      out.push({ ...linkView(s), exists });
    }
    res.json({ links: out });
  })
);

linksRouter.delete(
  '/links/:token',
  wrap(async (req, res) => {
    const s = getLink(req.params.token);
    if (!s) return res.json({ ok: true });
    if (s.created_by !== req.user.email && !req.user.isAdmin) throw httpError(403, 'Not your link');
    deleteLink(s.token);
    logActivity({ email: req.user.email, action: 'link_delete', path: s.rel_path, ip: clientIp(req) });
    res.json({ ok: true });
  })
);

// ══════════════════════════════════════════════════════════════════════
// Public access — NO login required. Mounted BEFORE the auth gate.
// Anyone with the token can view/download (read-only).
// ══════════════════════════════════════════════════════════════════════
export const publicLinksRouter = Router();

publicLinksRouter.get(
  '/links/:token/meta',
  wrap(async (req, res) => {
    const s = getLink(req.params.token);
    if (!s) throw httpError(404, 'This link is invalid or has expired');
    const { stat } = await resolveLinkTarget(s, '');
    logActivity({
      email: req.user?.email || null,
      action: 'link_open',
      path: s.rel_path,
      detail: req.user ? undefined : 'guest',
      ip: clientIp(req),
    });
    res.json({
      ...linkView(s),
      size: stat.isDirectory() ? null : stat.size,
      mtime: stat.mtimeMs,
    });
  })
);

publicLinksRouter.get(
  '/links/:token/list',
  wrap(async (req, res) => {
    const s = getLink(req.params.token);
    if (!s) throw httpError(404, 'This link is invalid or has expired');
    if (!s.is_dir) throw httpError(400, 'Not a folder link');
    const sub = cleanRel(req.query.sub || '');
    const target = await resolveLinkTarget(s, sub);
    if (!target.stat.isDirectory()) throw httpError(400, 'Not a folder');
    const listing = await listDir(target.rel);
    const prefix = resolveSafe(s.rel_path).rel;
    res.json({
      path: sub,
      entries: listing.entries.map((e) => ({
        ...e,
        path: e.path.slice(prefix.length + 1),
      })),
    });
  })
);

publicLinksRouter.get(
  '/links/:token/stream',
  wrap(async (req, res) => {
    const s = getLink(req.params.token);
    if (!s) throw httpError(404, 'This link is invalid or has expired');
    const target = await resolveLinkTarget(s, req.query.sub);
    if (target.stat.isDirectory()) throw httpError(400, 'Cannot stream a folder');
    streamFile(req, res, target.abs, target.stat, { mode: 'inline' });
  })
);

publicLinksRouter.get(
  '/links/:token/download',
  wrap(async (req, res) => {
    const s = getLink(req.params.token);
    if (!s) throw httpError(404, 'This link is invalid or has expired');
    const target = await resolveLinkTarget(s, req.query.sub);
    const name = target.rel.split('/').pop();
    logActivity({
      email: req.user?.email || null,
      action: 'link_download',
      path: target.rel,
      detail: req.user ? undefined : 'guest',
      ip: clientIp(req),
    });
    if (target.stat.isDirectory()) return streamZip(res, target.abs, name);
    streamFile(req, res, target.abs, target.stat, { mode: 'attachment' });
  })
);

publicLinksRouter.get(
  '/links/:token/thumb',
  wrap(async (req, res) => {
    const s = getLink(req.params.token);
    if (!s) throw httpError(404, 'Not found');
    const target = await resolveLinkTarget(s, req.query.sub);
    if (target.stat.isDirectory() || !canThumb(target.abs)) throw httpError(404, 'No thumbnail');
    const size = Math.min(Math.max(parseInt(req.query.s, 10) || 256, 64), 1024);
    const out = await thumbFor(target.abs, target.rel, size);
    if (!out) throw httpError(404, 'No thumbnail');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(out).pipe(res);
  })
);
