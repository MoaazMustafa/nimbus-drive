import { Router } from 'express';
import config from '../config.js';
import { httpError, wrap } from '../util.js';
import {
  listAllowlist,
  addAllowlist,
  removeAllowlist,
  listUsers,
  listActivity,
} from '../db.js';

export const adminRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

adminRouter.get(
  '/admin/overview',
  wrap(async (_req, res) => {
    res.json({
      adminEmail: config.adminEmail,
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

adminRouter.get(
  '/admin/activity',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const email = req.query.email ? String(req.query.email).trim().toLowerCase() : null;
    const action = req.query.action ? String(req.query.action).trim() : null;
    const { rows, total } = listActivity({ limit, offset, email, action });
    res.json({ activity: rows, total, limit, offset });
  })
);
