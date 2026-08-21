import fs from 'node:fs';
import { Router } from 'express';
import config from '../config.js';
import { httpError, randomToken, wrap } from '../util.js';
import { resolveSafe, statOrNull, listDir, kindOf, cleanRel } from '../fsx.js';
import { streamFile, streamZip } from '../stream.js';
import { thumbFor, canThumb } from '../thumbs.js';
import db, {
  insertShare,
  getShare,
  deleteShare,
  shareMembers,
  addShareMember,
  clearShareMembers,
  sharesForPath,
  sharesByCreator,
  sharesVisibleTo,
  isAuthorizedEmail,
} from '../db.js';
import { requireBrowse } from '../auth.js';

export const sharesRouter = Router();

function shareView(s, includeMembers) {
  const name = s.rel_path.split('/').pop() || '/';
  return {
    token: s.token,
    path: s.rel_path,
    name,
    isDir: !!s.is_dir,
    kind: kindOf(name, !!s.is_dir),
    mode: s.mode,
    createdBy: s.created_by,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    url: `${config.baseUrl}/s/${s.token}`,
    ...(includeMembers ? { members: shareMembers(s.token) } : {}),
  };
}

/** Creating and managing shares requires browse permission (you can only share what you can see). */
sharesRouter.post(
  '/shares',
  requireBrowse,
  wrap(async (req, res) => {
    const { path: relIn, mode, emails, expiresDays } = req.body || {};
    if (!['workspace', 'restricted'].includes(mode)) throw httpError(400, 'mode must be workspace or restricted');
    const { abs, rel } = resolveSafe(relIn);
    if (!rel) throw httpError(400, 'Cannot share the root folder');
    const st = await statOrNull(abs);
    if (!st) throw httpError(404, 'File not found');

    const memberEmails = (Array.isArray(emails) ? emails : [])
      .map((e) => String(e).trim().toLowerCase())
      .filter(Boolean);
    if (mode === 'restricted') {
      if (memberEmails.length === 0) throw httpError(400, 'Pick at least one person for a restricted share');
      for (const e of memberEmails) {
        if (!isAuthorizedEmail(e)) {
          throw httpError(400, `${e} is not an authorized user — add them to the allowlist first`);
        }
      }
    }

    const token = randomToken(16);
    insertShare.run({
      token,
      rel_path: rel,
      is_dir: st.isDirectory() ? 1 : 0,
      mode,
      created_by: req.user.email,
      created_at: Date.now(),
      expires_at: expiresDays ? Date.now() + Number(expiresDays) * 24 * 3600 * 1000 : null,
    });
    for (const e of memberEmails) addShareMember(token, e);
    res.json({ ok: true, share: shareView(getShare(token), true) });
  })
);

sharesRouter.get(
  '/shares',
  requireBrowse,
  wrap(async (req, res) => {
    const rel = cleanRel(req.query.path || '');
    if (!rel) return res.json({ shares: [] });
    let rows = sharesForPath(rel);
    if (!req.user.isAdmin) rows = rows.filter((s) => s.created_by === req.user.email);
    res.json({ shares: rows.map((s) => shareView(s, true)) });
  })
);

sharesRouter.get(
  '/shares/mine',
  requireBrowse,
  wrap(async (req, res) => {
    const rows = sharesByCreator(req.user.email);
    const out = [];
    for (const s of rows) {
      const { abs } = resolveSafe(s.rel_path);
      const exists = !!(await statOrNull(abs));
      out.push({ ...shareView(s, true), exists });
    }
    res.json({ shares: out });
  })
);

sharesRouter.get(
  '/shares/shared-with-me',
  wrap(async (req, res) => {
    const rows = sharesVisibleTo(req.user.email);
    const out = [];
    for (const s of rows) {
      const { abs } = resolveSafe(s.rel_path);
      if (!(await statOrNull(abs))) continue; // target gone — hide it
      out.push(shareView(s, false));
    }
    res.json({ shares: out });
  })
);

sharesRouter.patch(
  '/shares/:token',
  requireBrowse,
  wrap(async (req, res) => {
    const s = getShare(req.params.token);
    if (!s) throw httpError(404, 'Share not found');
    if (s.created_by !== req.user.email && !req.user.isAdmin) throw httpError(403, 'Not your share');
    const { mode, emails } = req.body || {};
    if (mode && !['workspace', 'restricted'].includes(mode)) throw httpError(400, 'Bad mode');
    const memberEmails = (Array.isArray(emails) ? emails : null)?.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
    if (memberEmails) {
      for (const e of memberEmails) {
        if (!isAuthorizedEmail(e)) throw httpError(400, `${e} is not an authorized user`);
      }
      clearShareMembers(s.token);
      for (const e of memberEmails) addShareMember(s.token, e);
    }
    if (mode) {
      db.prepare('UPDATE shares SET mode = ? WHERE token = ?').run(mode, s.token);
    }
    res.json({ ok: true, share: shareView(getShare(s.token), true) });
  })
);

sharesRouter.delete(
  '/shares/:token',
  requireBrowse,
  wrap(async (req, res) => {
    const s = getShare(req.params.token);
    if (!s) return res.json({ ok: true });
    if (s.created_by !== req.user.email && !req.user.isAdmin) throw httpError(403, 'Not your share');
    deleteShare(s.token);
    res.json({ ok: true });
  })
);

// ---------- accessing a share (any authorized user, if the share allows them) ----------

function assertShareAccess(req, s) {
  const email = req.user.email;
  if (req.user.isAdmin) return;
  if (s.created_by === email) return;
  if (s.mode === 'workspace') return; // any signed-in authorized user
  if (shareMembers(s.token).includes(email)) return;
  throw httpError(403, 'This item was not shared with you');
}

/** Resolve `sub` inside a shared folder, never escaping the share target. */
async function resolveShareTarget(s, sub) {
  const base = resolveSafe(s.rel_path);
  const baseStat = await statOrNull(base.abs);
  if (!baseStat) throw httpError(404, 'The shared item no longer exists');
  const subRel = cleanRel(sub || '');
  if (!subRel) return { abs: base.abs, rel: base.rel, stat: baseStat };
  if (!baseStat.isDirectory()) throw httpError(400, 'Not a folder share');
  const joined = resolveSafe(`${base.rel}/${subRel}`);
  const st = await statOrNull(joined.abs);
  if (!st) throw httpError(404, 'Not found');
  return { abs: joined.abs, rel: joined.rel, stat: st };
}

sharesRouter.get(
  '/shares/:token/meta',
  wrap(async (req, res) => {
    const s = getShare(req.params.token);
    if (!s) throw httpError(404, 'This link is invalid or has expired');
    assertShareAccess(req, s);
    const { stat } = await resolveShareTarget(s, '');
    res.json({
      ...shareView(s, false),
      size: stat.isDirectory() ? null : stat.size,
      mtime: stat.mtimeMs,
    });
  })
);

sharesRouter.get(
  '/shares/:token/list',
  wrap(async (req, res) => {
    const s = getShare(req.params.token);
    if (!s) throw httpError(404, 'This link is invalid or has expired');
    assertShareAccess(req, s);
    if (!s.is_dir) throw httpError(400, 'Not a folder share');
    const sub = cleanRel(req.query.sub || '');
    const target = await resolveShareTarget(s, sub);
    if (!target.stat.isDirectory()) throw httpError(400, 'Not a folder');
    const listing = await listDir(target.rel);
    // Rewrite paths to be share-relative so the client never sees real drive paths
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

sharesRouter.get(
  '/shares/:token/stream',
  wrap(async (req, res) => {
    const s = getShare(req.params.token);
    if (!s) throw httpError(404, 'This link is invalid or has expired');
    assertShareAccess(req, s);
    const target = await resolveShareTarget(s, req.query.sub);
    if (target.stat.isDirectory()) throw httpError(400, 'Cannot stream a folder');
    streamFile(req, res, target.abs, target.stat, { mode: 'inline' });
  })
);

sharesRouter.get(
  '/shares/:token/download',
  wrap(async (req, res) => {
    const s = getShare(req.params.token);
    if (!s) throw httpError(404, 'This link is invalid or has expired');
    assertShareAccess(req, s);
    const target = await resolveShareTarget(s, req.query.sub);
    const name = target.rel.split('/').pop();
    if (target.stat.isDirectory()) return streamZip(res, target.abs, name);
    streamFile(req, res, target.abs, target.stat, { mode: 'attachment' });
  })
);

sharesRouter.get(
  '/shares/:token/thumb',
  wrap(async (req, res) => {
    const s = getShare(req.params.token);
    if (!s) throw httpError(404, 'Not found');
    assertShareAccess(req, s);
    const target = await resolveShareTarget(s, req.query.sub);
    if (target.stat.isDirectory() || !canThumb(target.abs)) throw httpError(404, 'No thumbnail');
    const size = Math.min(Math.max(parseInt(req.query.s, 10) || 256, 64), 1024);
    const out = await thumbFor(target.abs, target.rel, size);
    if (!out) throw httpError(404, 'No thumbnail');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(out).pipe(res);
  })
);
