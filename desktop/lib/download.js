'use strict';
/**
 * Streaming file downloader with redirect-follow, progress reporting, retry,
 * and atomic writes (temp file -> rename). Used for GitHub tarballs, the
 * portable Node runtime, and cloudflared.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

/**
 * @param {string|string[]} urlInput  single URL or array of candidate fallback URLs
 * @param {string} destPath  final file path (parent dirs created)
 * @param {object} [opts]
 * @param {(info:{received:number,total:number|null,percent:number|null})=>void} [opts.onProgress]
 * @param {object} [opts.headers]
 * @param {number} [opts.timeoutMs]   inactivity/overall guard per attempt
 * @param {number} [opts.retries]
 * @param {AbortSignal} [opts.signal]
 */
async function downloadFile(urlInput, destPath, opts = {}) {
  const { onProgress, headers = {}, timeoutMs = 120000, retries = 3, signal } = opts;
  const urls = Array.isArray(urlInput) ? urlInput.filter(Boolean) : [urlInput];
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  let lastErr;

  for (let uIdx = 0; uIdx < urls.length; uIdx++) {
    const url = urls[uIdx];
    for (let attempt = 0; attempt <= retries; attempt++) {
      const tmp = `${destPath}.part-${process.pid}-${uIdx}-${attempt}`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error('download timed out')), timeoutMs);
        if (timer.unref) timer.unref();
        const onOuterAbort = () => ctrl.abort(signal.reason);
        if (signal) {
          if (signal.aborted) throw new Error('cancelled');
          signal.addEventListener('abort', onOuterAbort, { once: true });
        }
        try {
          const res = await fetch(url, {
            redirect: 'follow',
            headers: { 'User-Agent': 'nimbus-desktop', ...headers },
            signal: ctrl.signal,
          });
          if (!res.ok) {
            const err = new Error(`HTTP ${res.status} for ${url}`);
            err.status = res.status;
            throw err;
          }
          const total = Number(res.headers.get('content-length')) || null;
          let received = 0;
          const counter = async function* (source) {
            for await (const chunk of source) {
              received += chunk.length;
              if (onProgress) onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
              yield chunk;
            }
          };
          await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
          await fsp.rename(tmp, destPath);
          return { path: destPath, bytes: received };
        } finally {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onOuterAbort);
        }
      } catch (err) {
        lastErr = err;
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (signal?.aborted) throw new Error('cancelled');
        // If server returns HTTP 504 / 502 / 503 gateway error and fallback URL is available, switch immediately
        if ([504, 502, 503, 500, 429].includes(err.status) && uIdx < urls.length - 1) {
          break;
        }
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw new Error(`Download failed: ${lastErr?.message || 'unknown error'}`);
}

/** GET a JSON document (GitHub API etc.) with retry for transient server errors (e.g. 504). */
async function fetchJson(url, { headers = {}, timeoutMs = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'nimbus-desktop', Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} for ${url}${body ? ` — ${body.slice(0, 140)}` : ''}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.status === 404) throw err; // 404 is definitive, don't retry
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

module.exports = { downloadFile, fetchJson };
