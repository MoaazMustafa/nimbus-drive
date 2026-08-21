import { Router } from 'express';
import config from '../config.js';
import { httpError, wrap } from '../util.js';
import {
  listAllowlist,
  addAllowlist,
  removeAllowlist,
  listUsers,
  getVisibility,
  setSetting,
  allShares,
  deleteShare,
} from '../db.js';

export const adminRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

adminRouter.get(
  '/admin/overview',
  wrap(async (_req, res) => {
    res.json({
      adminEmail: config.adminEmail,
      visibility: getVisibility(),
      allowlist: listAllowlist(),
      users: listUsers(),
    });
  })
);

adminRouter.post(
  '/admin/allowlist',
  wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    if (!EMAIL_RE.test(email)) throw httpError(400, 'That does not look like an email address');
    if (email === config.adminEmail) throw httpError(400, 'The owner account is always allowed');
    addAllowlist(email, role, req.user.email);
    res.json({ ok: true, allowlist: listAllowlist() });
  })
);

adminRouter.delete(
  '/admin/allowlist/:email',
  wrap(async (req, res) => {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (email === config.adminEmail) throw httpError(400, 'Cannot remove the owner account');
    removeAllowlist(email); // also revokes their sessions immediately
    res.json({ ok: true, allowlist: listAllowlist() });
  })
);

adminRouter.post(
  '/admin/visibility',
  wrap(async (req, res) => {
    const v = req.body?.visibility;
    if (!['admin_only', 'everyone'].includes(v)) throw httpError(400, 'visibility must be admin_only or everyone');
    setSetting('visibility', v);
    res.json({ ok: true, visibility: v });
  })
);

adminRouter.get(
  '/admin/shares',
  wrap(async (_req, res) => {
    res.json({ shares: allShares() });
  })
);

adminRouter.delete(
  '/admin/shares/:token',
  wrap(async (req, res) => {
    deleteShare(req.params.token);
    res.json({ ok: true });
  })
);
