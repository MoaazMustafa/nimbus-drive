'use strict';
/** Tiny version compare for release tags ("v1.0.13") vs app versions ("1.0.12"). */
function parts(v) {
  const clean = String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
  const nums = clean.split('.').map((n) => parseInt(n, 10));
  if (!nums.length || nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

/** true when `candidate` is a strictly newer version than `current`. */
function isNewerVersion(candidate, current) {
  const a = parts(candidate);
  const b = parts(current);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

module.exports = { isNewerVersion };
