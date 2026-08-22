'use strict';
/**
 * Ring buffer of log lines per process, with optional append-to-file.
 * Keeps the UI responsive (bounded memory) while full logs land on disk.
 */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

class LogBuffer extends EventEmitter {
  constructor({ name, capacity = 2000, filePath = null, maxFileBytes = 5 * 1024 * 1024 } = {}) {
    super();
    this.name = name || 'log';
    this.capacity = capacity;
    this.lines = [];
    this.nextId = 1;
    this.filePath = filePath;
    this.maxFileBytes = maxFileBytes;
    if (filePath) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // rotate a too-big previous log once at startup
        const st = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
        if (st && st.size > maxFileBytes) {
          fs.rmSync(`${filePath}.1`, { force: true });
          fs.renameSync(filePath, `${filePath}.1`);
        }
        this.stream = fs.createWriteStream(filePath, { flags: 'a' });
        this.stream.on('error', () => { this.stream = null; });
      } catch {
        this.stream = null;
      }
    }
  }

  push(text, level = 'info') {
    const stamp = new Date();
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      const entry = { id: this.nextId++, ts: stamp.getTime(), level, line };
      this.lines.push(entry);
      if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
      if (this.stream) {
        try {
          this.stream.write(`${stamp.toISOString()} ${line}\n`);
        } catch { /* best-effort */ }
      }
      this.emit('line', entry);
    }
  }

  get({ afterId = 0, filter = '', limit = 500 } = {}) {
    let out = this.lines;
    if (afterId) out = out.filter((l) => l.id > afterId);
    if (filter) {
      const f = String(filter).toLowerCase();
      out = out.filter((l) => l.line.toLowerCase().includes(f));
    }
    return out.slice(-limit);
  }

  text() {
    return this.lines.map((l) => `${new Date(l.ts).toISOString()} ${l.line}`).join('\n');
  }

  clear() {
    this.lines = [];
    this.emit('clear');
  }

  close() {
    try { this.stream?.end(); } catch { /* ignore */ }
  }
}

module.exports = { LogBuffer };
