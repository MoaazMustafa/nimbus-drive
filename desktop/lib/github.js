'use strict';
/**
 * Minimal GitHub client for a PUBLIC repo: latest release (preferred) with a
 * fall-back to the default branch when no release exists yet. `apiBase` is
 * overridable so tests can point it at a local mock server.
 */
const { fetchJson } = require('./download');

/** Accepts "owner/repo" or a full github.com URL; returns {owner, repo} or null. */
function parseRepo(input) {
  const s = String(input || '').trim();
  let m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
  return null;
}

class GitHub {
  constructor({ apiBase = 'https://api.github.com', token = null } = {}) {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.token = token;
  }

  headers() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /**
   * The newest installable version of a repo.
   * @returns {{kind:'release'|'branch', version:string, name:string, notes:string, tarballUrl:string, publishedAt:string|null}}
   */
  async latestVersion(owner, repo) {
    // Prefer a tagged release
    try {
      const rel = await fetchJson(`${this.apiBase}/repos/${owner}/${repo}/releases/latest`, { headers: this.headers() });
      if (rel && rel.tag_name) {
        const tag = rel.tag_name;
        const mainUrl = rel.tarball_url || `${this.apiBase}/repos/${owner}/${repo}/tarball/${tag}`;
        return {
          kind: 'release',
          version: tag,
          name: rel.name || tag,
          notes: rel.body || '',
          tarballUrl: mainUrl,
          tarballUrls: [
            `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/tags/${tag}`,
            `https://github.com/${owner}/${repo}/archive/refs/tags/${tag}.tar.gz`,
            mainUrl,
          ],
          publishedAt: rel.published_at || null,
        };
      }
    } catch (err) {
      if (err.status && err.status !== 404) throw friendly(err, owner, repo);
      // 404 = no releases yet → fall through to branch
    }
    try {
      const info = await fetchJson(`${this.apiBase}/repos/${owner}/${repo}`, { headers: this.headers() });
      const branch = info.default_branch || 'main';
      const commits = await fetchJson(`${this.apiBase}/repos/${owner}/${repo}/commits/${branch}`, { headers: this.headers() });
      const sha = (commits.sha || '').slice(0, 7) || 'head';
      const mainUrl = `${this.apiBase}/repos/${owner}/${repo}/tarball/${branch}`;
      return {
        kind: 'branch',
        version: `${branch}-${sha}`,
        name: `Latest ${branch} (${sha})`,
        notes: commits.commit?.message || '',
        tarballUrl: mainUrl,
        tarballUrls: [
          `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`,
          `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.tar.gz`,
          mainUrl,
        ],
        publishedAt: commits.commit?.committer?.date || null,
      };
    } catch (err) {
      throw friendly(err, owner, repo);
    }
  }
}

function friendly(err, owner, repo) {
  if (err.status === 404) return new Error(`GitHub repo "${owner}/${repo}" was not found — check the name (and that it's public).`);
  if (err.status === 403) return new Error('GitHub rate limit reached — wait a few minutes and try again.');
  if (String(err.message || '').includes('fetch failed')) return new Error('Could not reach GitHub — check the internet connection.');
  return err;
}

module.exports = { GitHub, parseRepo };
