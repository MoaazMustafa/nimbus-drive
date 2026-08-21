import path from 'node:path';
import fsp from 'node:fs/promises';
import sharp from 'sharp';
import config from './config.js';
import { sha1 } from './util.js';
import { statOrNull } from './fsx.js';

const THUMB_DIR = path.join(config.dataDir, 'thumbs');
const THUMBABLE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tiff', '.tif', '.svg', '.bmp']);

export function canThumb(name) {
  return THUMBABLE.has(path.extname(name).toLowerCase());
}

/**
 * Return the absolute path of a cached thumbnail for `abs`, generating it if needed.
 * Cache key includes size + mtime so edits invalidate automatically.
 * Returns null when a thumbnail cannot be produced (corrupt/unsupported file).
 */
export async function thumbFor(abs, relKey, size) {
  const st = await statOrNull(abs);
  if (!st || !st.isFile()) return null;
  const key = sha1(`${relKey}|${st.size}|${Math.round(st.mtimeMs)}|${size}`);
  const out = path.join(THUMB_DIR, `${key}.webp`);
  if (await statOrNull(out)) return out;
  try {
    await sharp(abs, { failOn: 'truncated' })
      .rotate() // respect EXIF orientation
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .webp({ quality: 72 })
      .toFile(out + '.part');
    await fsp.rename(out + '.part', out);
    return out;
  } catch {
    await fsp.rm(out + '.part', { force: true }).catch(() => {});
    return null;
  }
}

/** Occasionally trim the thumbnail cache so it cannot grow forever. */
export async function pruneThumbs(maxBytes = 512 * 1024 * 1024) {
  try {
    const names = await fsp.readdir(THUMB_DIR);
    const stats = [];
    let total = 0;
    for (const n of names) {
      const s = await statOrNull(path.join(THUMB_DIR, n));
      if (!s) continue;
      total += s.size;
      stats.push({ n, size: s.size, atime: s.atimeMs });
    }
    if (total <= maxBytes) return;
    stats.sort((a, b) => a.atime - b.atime);
    for (const f of stats) {
      if (total <= maxBytes * 0.8) break;
      await fsp.rm(path.join(THUMB_DIR, f.n), { force: true });
      total -= f.size;
    }
  } catch {
    /* cache pruning is best-effort */
  }
}
