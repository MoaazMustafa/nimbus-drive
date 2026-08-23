import path from 'node:path';

/**
 * Attached folders ("libraries").
 *
 * A drive used to be one folder: STORAGE_ROOT. That is limiting the moment your
 * photos live on D: and your documents on E:. Extra folders are declared in
 * STORAGE_ROOTS and each becomes a named library with its own id.
 *
 * Paths are addressed as "<library-id>/<path inside it>". An unprefixed path
 * still resolves against the FIRST library, so every link, trash entry and
 * bookmark created before this existed keeps working untouched.
 *
 * Accepted forms for STORAGE_ROOTS (whichever is easier to type):
 *   Photos=D:\Photos; Documents=E:\Docs
 *   D:\Photos; E:\Docs                    (name taken from the folder)
 *   [{"name":"Photos","path":"D:\\Photos"}]
 *   {"Photos":"D:\\Photos"}
 */

/** "My Photos (2026)" -> "my-photos-2026" */
export function slugify(name) {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'folder';
}

/** A readable name for a bare path: D:\ -> "D drive", E:\Media -> "Media". */
export function nameForPath(p) {
  const norm = String(p || '').replace(/[\\/]+$/, '');
  // Check this BEFORE basename: path.basename('D:') is '' on Windows but 'D:'
  // on Linux, and the tests (and CI) run on Linux.
  const drive = /^([A-Za-z]):$/.exec(norm);
  if (drive) return `${drive[1].toUpperCase()} drive`;
  const base = path.basename(norm);
  return base || 'Drive';
}

/** Split the declaration string into {name, path} pairs, in order. */
export function parseRootsSpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return [];

  // JSON is unambiguous, so try it first
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data
          .map((e) => (typeof e === 'string' ? { name: '', path: e } : { name: e?.name || '', path: e?.path || e?.root || '' }))
          .filter((e) => e.path);
      }
      if (data && typeof data === 'object') {
        return Object.entries(data).map(([name, p]) => ({ name, path: String(p) })).filter((e) => e.path);
      }
    } catch { /* fall through to the plain form */ }
  }

  const out = [];
  for (const chunk of raw.split(/[;\n]+/)) {
    const entry = chunk.trim();
    if (!entry) continue;
    // Split on the FIRST '=' only — Windows paths contain ':' but never '='
    const eq = entry.indexOf('=');
    if (eq > 0) out.push({ name: entry.slice(0, eq).trim(), path: entry.slice(eq + 1).trim() });
    else out.push({ name: '', path: entry });
  }
  return out.filter((e) => e.path);
}

/**
 * Build the final library list: the default root first, then the extras.
 * Ids are unique; duplicate roots are dropped.
 *
 * @returns {{libraries: Array<{id,name,root,isDefault}>, problems: string[]}}
 */
export function buildLibraries({ defaultRoot, defaultName = 'My Drive', spec = '', resolve = (p) => path.resolve(p) } = {}) {
  const problems = [];
  const libraries = [];
  const seenRoots = new Set();
  const seenIds = new Set();

  const add = (name, rootRaw, isDefault) => {
    let root;
    try { root = resolve(rootRaw); } catch { problems.push(`Could not resolve the folder "${rootRaw}".`); return; }
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seenRoots.has(key)) {
      problems.push(`"${rootRaw}" is attached more than once — the duplicate was ignored.`);
      return;
    }
    seenRoots.add(key);
    let id = slugify(name || nameForPath(root));
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    seenIds.add(id);
    libraries.push({ id, name: (name || nameForPath(root)).trim(), root, isDefault: !!isDefault });
  };

  if (defaultRoot) add(defaultName, defaultRoot, true);
  for (const entry of parseRootsSpec(spec)) add(entry.name, entry.path, false);
  return { libraries, problems };
}

/**
 * Which library does this relative path belong to, and what is left of it?
 * An unprefixed path belongs to the default library — that is what keeps links
 * made before multiple folders existed pointing at the same file.
 */
export function splitLibraryPath(rel, libraries) {
  const parts = String(rel || '').split('/').filter(Boolean);
  const head = parts[0];
  const match = head ? libraries.find((l) => l.id === head) : null;
  if (match) return { library: match, sub: parts.slice(1), prefixed: true };
  return { library: libraries[0] || null, sub: parts, prefixed: false };
}

/** The canonical, always-prefixed form of a path. */
export function canonicalPath(library, sub) {
  if (!library) return sub.join('/');
  return [library.id, ...sub].filter(Boolean).join('/');
}
