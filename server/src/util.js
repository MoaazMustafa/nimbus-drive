import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const httpError = (status, message) => new HttpError(status, message);

export const randomToken = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

export const now = () => Date.now();

/** Wrap an async express handler so rejections reach the error middleware (express 5 does this natively, kept for clarity/safety). */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function clientIp(req) {
  return (req.headers['cf-connecting-ip'] || req.ip || '').toString();
}

/**
 * Escape a string so it can be used as a literal inside a SQL LIKE pattern.
 * Without this, filenames containing "_" or "%" act as wildcards — which used
 * to make deleting/renaming one item silently affect unrelated links.
 * Use together with:  ... LIKE ? ESCAPE '\\'
 */
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}
