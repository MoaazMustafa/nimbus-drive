'use strict';
/** Port utilities: free-port detection and best-effort PID lookup per platform. */
const net = require('node:net');
const { execFile } = require('node:child_process');

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findFreePort(start, { host = '127.0.0.1', limit = 50 } = {}) {
  for (let p = start; p < start + limit; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p, host)) return p;
  }
  throw new Error(`No free port found in ${start}–${start + limit - 1}`);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

/** Best-effort: PID of whatever is LISTENING on the port; null when unknown. */
async function findPidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of out.split(/\r?\n/)) {
        // Proto Local Foreign State PID
        const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
        if (m && Number(m[2]) === Number(port)) return Number(m[3]);
      }
      return null;
    }
    // Linux/macOS: try lsof, then ss.
    let out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pid = parseInt(out.trim().split(/\s+/)[0], 10);
    if (Number.isInteger(pid)) return pid;
    out = await run('ss', ['-ltnp', `sport = :${port}`]);
    const m = /pid=(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

module.exports = { isPortFree, findFreePort, findPidOnPort };
