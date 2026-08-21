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
