'use strict';
/**
 * Private runtimes the app downloads for itself, so a brand-new PC needs
 * NOTHING pre-installed:
 *   - a pinned portable Node.js (runs the server, npm, and the web build)
 *   - cloudflared (optional, only when the tunnel is enabled)
 * Everything lands inside the app's own data dir and never touches the system.
 * Extraction uses the OS `tar` (present on Windows 10+, macOS and Linux).
 */
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { downloadFile } = require('./download');

// Pinned, known-good LTS. Bump deliberately, not automatically.
const NODE_VERSION = '22.15.0';

function nodeDistFor(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return { file: `node-v${NODE_VERSION}-win-${a}.zip`, dir: `node-v${NODE_VERSION}-win-${a}` };
  if (platform === 'darwin') return { file: `node-v${NODE_VERSION}-darwin-${a}.tar.gz`, dir: `node-v${NODE_VERSION}-darwin-${a}` };
  return { file: `node-v${NODE_VERSION}-linux-${a}.tar.gz`, dir: `node-v${NODE_VERSION}-linux-${a}` };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeoutMs || 120000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${String(stderr || err.message).slice(0, 400)}`));
      else resolve(String(stdout));
    });
  });
}

/** Extract .zip / .tar.gz with the system tar (bsdtar on Windows handles both). */
async function extractArchive(archivePath, destDir, { stripComponents = 0 } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  // Mode flag first, then long options, then -f <file>: this ordering is
  // accepted by both GNU tar (Linux) and bsdtar (Windows 10+/macOS).
  const args = ['-x'];
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`);
  args.push('-f', archivePath, '-C', destDir);
  await run('tar', args, { timeoutMs: 300000 });
}

function findFile(dir, names, depth = 3) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && names.includes(e.name)) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFile(path.join(dir, e.name), names, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Ensure the portable Node runtime exists; download + extract + verify if not.
 * @returns {{nodeBin:string, npmCli:string, version:string}}
 */
async function ensureNode({ homeDir, onProgress, distBase = 'https://nodejs.org/dist', platform = process.platform, arch = process.arch, signal } = {}) {
  const { file, dir } = nodeDistFor(platform, arch);
  const runtimeRoot = path.join(homeDir, 'runtime');
  const nodeRoot = path.join(runtimeRoot, dir);

  const locate = () => {
    const nodeBin = findFile(nodeRoot, platform === 'win32' ? ['node.exe'] : ['node'], 2);
    const npmCli = findFile(nodeRoot, ['npm-cli.js'], 6);
    return nodeBin && npmCli ? { nodeBin, npmCli, version: NODE_VERSION } : null;
  };

  const existing = locate();
  if (existing) {
    // sanity: does it still run?
    try {
      await run(existing.nodeBin, ['--version'], { timeoutMs: 15000 });
      return existing;
    } catch {
      await fsp.rm(nodeRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  const archive = path.join(runtimeRoot, file);
  const url = `${distBase.replace(/\/+$/, '')}/v${NODE_VERSION}/${file}`;
  await downloadFile(url, archive, { onProgress, timeoutMs: 600000, signal });
  await extractArchive(archive, runtimeRoot);
  await fsp.rm(archive, { force: true }).catch(() => {});

  const found = locate();
  if (!found) throw new Error('Node runtime downloaded but node/npm could not be located after extraction.');
  const v = (await run(found.nodeBin, ['--version'], { timeoutMs: 20000 })).trim();
  if (!v.startsWith('v')) throw new Error(`Node runtime verification failed (got "${v}")`);
  return found;
}

const CLOUDFLARED_ASSETS = {
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-arm64': 'cloudflared-windows-amd64.exe', // runs under emulation
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
};

/** Ensure cloudflared exists in the app's runtime dir; download if missing. */
async function ensureCloudflared({ homeDir, onProgress, baseUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download', platform = process.platform, arch = process.arch, signal } = {}) {
  const key = `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  const asset = CLOUDFLARED_ASSETS[key];
  if (!asset) throw new Error(`No cloudflared build for ${key}`);
  const binName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const dest = path.join(homeDir, 'runtime', 'cloudflared', binName);
  if (fs.existsSync(dest)) return dest;

  const url = `${baseUrl.replace(/\/+$/, '')}/${asset}`;
  if (asset.endsWith('.tgz')) {
    const tmp = `${dest}.tgz`;
    await downloadFile(url, tmp, { onProgress, timeoutMs: 300000, signal });
    await extractArchive(tmp, path.dirname(dest));
    await fsp.rm(tmp, { force: true }).catch(() => {});
  } else {
    await downloadFile(url, dest, { onProgress, timeoutMs: 300000, signal });
  }
  if (platform !== 'win32') await fsp.chmod(dest, 0o755).catch(() => {});
  return dest;
}

module.exports = { ensureNode, ensureCloudflared, extractArchive, NODE_VERSION, nodeDistFor };
