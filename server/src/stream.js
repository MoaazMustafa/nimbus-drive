import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { ZipArchive } from 'archiver';
import { httpError } from './util.js';

/**
 * Stream a file with HTTP Range support (video/audio seeking, resumable downloads).
 * mode: 'inline' (preview) | 'attachment' (download)
 */
export function streamFile(req, res, abs, stat, { mode = 'inline', filename } = {}) {
  const name = filename || path.basename(abs);
  const type = mime.lookup(name) || 'application/octet-stream';
  const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
  // Private: never let a shared cache hold authorized content
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader(
    'Content-Disposition',
    `${mode === 'attachment' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', type);

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) start = parseInt(m[1], 10);
      if (m[2]) end = m[1] ? parseInt(m[2], 10) : stat.size - Math.min(parseInt(m[2], 10), stat.size);
      if (!m[1] && m[2]) {
        start = stat.size - Math.min(parseInt(m[2], 10), stat.size);
        end = stat.size - 1;
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        throw httpError(416, 'Range not satisfiable');
      }
      end = Math.min(end, stat.size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    }
  }
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Stream a folder as a zip download. */
export function streamZip(res, absDir, zipName) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(zipName.endsWith('.zip') ? zipName : zipName + '.zip')}`
  );
  res.setHeader('Cache-Control', 'private, no-store');
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('warning', () => {});
  archive.on('error', () => res.destroy());
  res.on('close', () => archive.destroy());
  archive.pipe(res);
  archive.directory(absDir, path.basename(zipName, '.zip'));
  archive.finalize();
}
