import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Router } from 'express';
import Busboy from 'busboy';
import config from '../config.js';
import { httpError, wrap } from '../util.js';
import {
  ROOT,
  resolveSafe,
  validateName,
  statOrNull,
  listDir,
  uniqueName,
  moveResilient,
  searchFiles,
  kindOf,
} from '../fsx.js';
import { streamFile, streamZip } from '../stream.js';
import { thumbFor, canThumb } from '../thumbs.js';
import { retargetShares, dropSharesUnder } from '../db.js';

export const filesRouter = Router();

filesRouter.get(
  '/fs/list',
  wrap(async (req, res) => {
    res.json(await listDir(req.query.path || ''));
  })
);

filesRouter.get(
  '/fs/stat',
  wrap(async (req, res) => {
    const { abs, rel } = resolveSafe(req.query.path || '');
    const st = await statOrNull(abs);
    if (!st) throw httpError(404, 'Not found');
    const name = rel ? rel.split('/').pop() : '/';
    res.json({
      name,
      path: rel,
      isDir: st.isDirectory(),
      size: st.isDirectory() ? null : st.size,
      mtime: st.mtimeMs,
      kind: kindOf(name, st.isDirectory()),
    });
  })
);

filesRouter.post(
  '/fs/mkdir',
  wrap(async (req, res) => {
    const { dir = '', name } = req.body || {};
    const safeName = validateName(name);
    const { abs: dirAbs, rel: dirRel } = resolveSafe(dir);
    const finalName = await uniqueName(dirAbs, safeName);
    await fsp.mkdir(path.join(dirAbs, finalName));
    res.json({ ok: true, path: dirRel ? `${dirRel}/${finalName}` : finalName, name: finalName });
  })
);

filesRouter.post(
  '/fs/rename',
  wrap(async (req, res) => {
    const { path: relIn, newName } = req.body || {};
    const safeName = validateName(newName);
    const { abs, rel } = resolveSafe(relIn);
    if (!rel) throw httpError(400, 'Cannot rename the root folder');
    const st = await statOrNull(abs);
    if (!st) throw httpError(404, 'Not found');
    const parentAbs = path.dirname(abs);
    const target = path.join(parentAbs, safeName);
    if (target === abs) return res.json({ ok: true, path: rel, name: safeName });
    if (await statOrNull(target)) throw httpError(409, 'Something with that name already exists here');
    await fsp.rename(abs, target);
    const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const newRel = parentRel ? `${parentRel}/${safeName}` : safeName;
    retargetShares(rel, newRel);
    res.json({ ok: true, path: newRel, name: safeName });
  })
);

filesRouter.post(
  '/fs/move',
  wrap(async (req, res) => {
    const { paths, destDir } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) throw httpError(400, 'Nothing to move');
    const { abs: destAbs, rel: destRel } = resolveSafe(destDir ?? '');
    const destStat = await statOrNull(destAbs);
    if (!destStat || !destStat.isDirectory()) throw httpError(400, 'Destination folder not found');
    const moved = [];
    for (const p of paths) {
      const { abs, rel } = resolveSafe(p);
      if (!rel) throw httpError(400, 'Cannot move the root folder');
      const st = await statOrNull(abs);
      if (!st) throw httpError(404, `Not found: ${rel}`);
      // Refuse to move a folder inside itself
      if (st.isDirectory() && (destRel === rel || destRel.startsWith(rel + '/'))) {
        throw httpError(400, 'Cannot move a folder into itself');
      }
      const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      if (parentRel === destRel) continue; // already there
      const name = rel.split('/').pop();
      const finalName = await uniqueName(destAbs, name);
      await moveResilient(abs, path.join(destAbs, finalName));
      const newRel = destRel ? `${destRel}/${finalName}` : finalName;
      retargetShares(rel, newRel);
      moved.push({ from: rel, to: newRel });
    }
    res.json({ ok: true, moved });
  })
);

filesRouter.post(
  '/fs/delete',
  wrap(async (req, res) => {
    const { paths } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) throw httpError(400, 'Nothing to delete');
    const deleted = [];
    for (const p of paths) {
      const { abs, rel } = resolveSafe(p);
      if (!rel) throw httpError(400, 'Cannot delete the root folder');
      const st = await statOrNull(abs);
      if (!st) continue;
      if (config.trashEnabled) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashName = `${stamp}__${rel.replace(/\//g, '__')}`.slice(0, 240);
        await moveResilient(abs, path.join(config.dataDir, 'trash', trashName));
      } else {
        await fsp.rm(abs, { recursive: true, force: true });
      }
      dropSharesUnder(rel);
      deleted.push(rel);
    }
    res.json({ ok: true, deleted, trashed: config.trashEnabled });
  })
);

filesRouter.post('/fs/upload', (req, res, next) => {
  let dirInfo;
  try {
    dirInfo = resolveSafe(req.query.dir || '');
  } catch (e) {
    return next(e);
  }
  fs.stat(dirInfo.abs, (err, st) => {
    if (err || !st.isDirectory()) return next(httpError(400, 'Upload folder not found'));

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 100 },
      });
    } catch (e) {
      return next(httpError(400, 'Malformed upload'));
    }

    const tmpDir = path.join(config.dataDir, 'tmp');
    const saved = [];
    const pending = [];
    let aborted = false;

    busboy.on('file', (field, fileStream, info) => {
      const rawName = path.basename((info.filename || 'file').replace(/\\/g, '/'));
      let name;
      try {
        name = validateName(rawName);
      } catch {
        name = rawName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'file';
      }
      const tmpPath = path.join(tmpDir, `up-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
      let tooBig = false;
      fileStream.on('limit', () => {
        tooBig = true;
        fileStream.unpipe(out);
        out.destroy();
        fs.rm(tmpPath, { force: true }, () => {});
      });
      const done = new Promise((resolve) => {
        out.on('close', resolve);
        out.on('error', resolve);
        fileStream.on('limit', resolve);
      }).then(async () => {
        if (aborted || tooBig) {
          await fsp.rm(tmpPath, { force: true }).catch(() => {});
          if (tooBig) saved.push({ name, ok: false, error: `Larger than the ${config.maxUploadMb} MB limit` });
          return;
        }
        try {
          const finalName = await uniqueName(dirInfo.abs, name);
          await moveResilient(tmpPath, path.join(dirInfo.abs, finalName));
          saved.push({
            name: finalName,
            ok: true,
            path: dirInfo.rel ? `${dirInfo.rel}/${finalName}` : finalName,
          });
        } catch (e) {
          await fsp.rm(tmpPath, { force: true }).catch(() => {});
          saved.push({ name, ok: false, error: 'Could not save file' });
        }
      });
      pending.push(done);
      fileStream.pipe(out);
    });

    busboy.on('error', () => {
      aborted = true;
      next(httpError(400, 'Upload failed'));
    });
    busboy.on('finish', async () => {
      await Promise.all(pending);
      if (!aborted) res.json({ ok: true, files: saved });
    });
    req.on('aborted', () => {
      aborted = true;
    });
    req.pipe(busboy);
  });
});

filesRouter.get(
  '/fs/download',
  wrap(async (req, res) => {
    const { abs, rel } = resolveSafe(req.query.path || '');
    const st = await statOrNull(abs);
    if (!st) throw httpError(404, 'Not found');
    const name = rel ? rel.split('/').pop() : config.appName;
    if (st.isDirectory()) return streamZip(res, abs, name);
    streamFile(req, res, abs, st, { mode: 'attachment' });
  })
);

filesRouter.get(
  '/fs/stream',
  wrap(async (req, res) => {
    const { abs } = resolveSafe(req.query.path || '');
    const st = await statOrNull(abs);
    if (!st || st.isDirectory()) throw httpError(404, 'Not found');
    streamFile(req, res, abs, st, { mode: 'inline' });
  })
);

filesRouter.get(
  '/fs/text',
  wrap(async (req, res) => {
    const { abs } = resolveSafe(req.query.path || '');
    const st = await statOrNull(abs);
    if (!st || st.isDirectory()) throw httpError(404, 'Not found');
    if (st.size > 512 * 1024) throw httpError(413, 'Too large for text preview');
    const buf = await fsp.readFile(abs);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.send(buf.toString('utf8'));
  })
);

filesRouter.get(
  '/fs/thumb',
  wrap(async (req, res) => {
    const { abs, rel } = resolveSafe(req.query.path || '');
    if (!canThumb(abs)) throw httpError(404, 'No thumbnail');
    const size = Math.min(Math.max(parseInt(req.query.s, 10) || 256, 64), 1024);
    const out = await thumbFor(abs, rel, size);
    if (!out) throw httpError(404, 'No thumbnail');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(out).pipe(res);
  })
);

filesRouter.get(
  '/fs/search',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [], truncated: false });
    res.json(await searchFiles(q));
  })
);

filesRouter.get(
  '/fs/stats',
  wrap(async (_req, res) => {
    // Cheap, cached storage overview
    res.json(await getStatsCached());
  })
);

let statsCache = { at: 0, value: null };
async function getStatsCached() {
  if (statsCache.value && Date.now() - statsCache.at < 60_000) return statsCache.value;
  let files = 0;
  let folders = 0;
  let bytes = 0;
  let visited = 0;
  async function walk(dir) {
    if (visited > 100_000) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (d.name === '.nimbus-tmp') continue;
      visited++;
      const p = path.join(dir, d.name);
      try {
        const s = await fsp.stat(p);
        if (s.isDirectory()) {
          folders++;
          await walk(p);
        } else {
          files++;
          bytes += s.size;
        }
      } catch {
        /* ignore */
      }
    }
  }
  await walk(ROOT);
  statsCache = { at: Date.now(), value: { files, folders, bytes, truncated: visited > 100_000 } };
  return statsCache.value;
}
