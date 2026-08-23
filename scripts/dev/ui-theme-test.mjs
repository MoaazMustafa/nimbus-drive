#!/usr/bin/env node
/**
 * Theme audit for the control panel.
 *
 * "Looks professional" is mostly measurable: one accent used consistently, and
 * text that is actually readable on the surface behind it. #acec00 is a
 * high-luminance lime — as text on white it measures 1.4:1, which no one can
 * read — so these tests exist to make sure it is only ever used as a fill
 * behind dark ink, and that nothing dark-theme survived the switch.
 *
 * Every ratio below is computed from the REAL rendered colours of elements
 * styled by the real stylesheet, not from the source.
 *
 *   node scripts/dev/ui-theme-test.mjs
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = path.join(ROOT, 'desktop', 'ui', 'index.html');

let passed = 0, failed = 0; const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✘ ${name} ${extra}`); }
};

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  if (process.env.CI) { console.log('  ✘ playwright is missing in CI — the theme audit did not run'); process.exit(1); }
  console.log('  – skipped (playwright not installed)');
  process.exit(0);
}

const ACCENT = '#acec00';
/** WCAG relative luminance / contrast, run in the page against computed colours. */
const PROBE = `(() => {
  const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const p = parse(c);
      const alpha = (c.match(/[\\d.]+/g) || [])[3];
      if (p.length === 3 && alpha !== '0') return p;
    }
    return [255, 255, 255];
  };

  // render one probe of every surface/text pairing the panel actually uses
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px';
  host.innerHTML = \`
    <div class="card">
      <button class="btn primary" id="p-primary">Primary</button>
      <button class="btn" id="p-btn">Secondary</button>
      <span class="pill green" id="p-green">ok</span>
      <span class="pill yellow" id="p-yellow">warn</span>
      <span class="pill red" id="p-red">bad</span>
      <span class="pill gray" id="p-gray">idle</span>
      <span class="muted" id="p-muted">muted text</span>
      <span class="hint" id="p-hint">hint text</span>
      <span class="linklike" id="p-link">a link</span>
      <div class="svc-meta" id="p-meta">meta</div>
      <ul class="checks"><li class="fail"><span class="mark fail" id="p-mark">x</span><span class="head"><span class="name" id="p-name">n</span><span class="why" id="p-why">why</span></span><span class="fix" id="p-fix">fix</span></li></ul>
      <div class="seg"><button class="seg-btn active" id="p-seg">Active</button><button class="seg-btn" id="p-seg2">Idle</button></div>
      <pre class="logview" id="p-log">log</pre>
      <div class="card inner"><h3 id="p-h3">Inner</h3></div>
    </div>\`;
  document.body.append(host);
  const at = (id) => {
    const el = document.getElementById(id);
    return { fg: parse(getComputedStyle(el).color), bg: bgOf(el) };
  };
  const out = {};
  for (const id of ['p-primary','p-btn','p-green','p-yellow','p-red','p-gray','p-muted','p-hint','p-link','p-meta','p-mark','p-name','p-why','p-fix','p-seg','p-seg2','p-log','p-h3']) {
    const { fg, bg } = at(id);
    out[id] = { ratio: ratio(fg, bg), fg, bg };
  }
  const root = getComputedStyle(document.documentElement);
  out.tokens = {
    accent: root.getPropertyValue('--accent').trim(),
    bg: parse(getComputedStyle(document.body).backgroundColor),
  };
  out.bodyText = { ratio: ratio(parse(getComputedStyle(document.body).color), parse(getComputedStyle(document.body).backgroundColor)) };
  out.bodyLum = lum(out.tokens.bg);
  out.primaryBgIsAccent = getComputedStyle(document.getElementById('p-primary')).backgroundColor;
  host.remove();
  return out;
})()`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => { window.nimbus = new Proxy({}, { get: () => () => Promise.resolve({}) }); });
await page.goto('file://' + UI);
await page.waitForTimeout(200);
const m = await page.evaluate(PROBE);

console.log('\n— the theme is light and the accent is the one asked for');
check('--accent is exactly #acec00', m.tokens.accent.toLowerCase() === ACCENT, m.tokens.accent);
check('the page background is light', m.bodyLum > 0.85, `luminance ${m.bodyLum.toFixed(3)}`);
check('the primary button is filled with the accent', /172,\s*236,\s*0/.test(m.primaryBgIsAccent), m.primaryBgIsAccent);

console.log('\n— every text/surface pairing is readable (WCAG AA, 4.5:1)');
const AA = 4.5;
const TEXT = {
  'body text': m.bodyText.ratio,
  'primary button label on the accent': m['p-primary'].ratio,
  'secondary button label': m['p-btn'].ratio,
  'green pill': m['p-green'].ratio,
  'yellow pill': m['p-yellow'].ratio,
  'red pill': m['p-red'].ratio,
  'gray pill': m['p-gray'].ratio,
  'muted text': m['p-muted'].ratio,
  'hint text': m['p-hint'].ratio,
  'service meta': m['p-meta'].ratio,
  'link text': m['p-link'].ratio,
  'check name': m['p-name'].ratio,
  'check explanation': m['p-why'].ratio,
  'check fix box': m['p-fix'].ratio,
  'active log filter tab': m['p-seg'].ratio,
  'inactive log filter tab': m['p-seg2'].ratio,
  'log output': m['p-log'].ratio,
  'inner panel heading': m['p-h3'].ratio,
};
for (const [label, r] of Object.entries(TEXT)) {
  check(`${label} — ${r.toFixed(2)}:1`, r >= AA, `needs ${AA}:1`);
}

console.log('\n— non-text marks clear the 3:1 UI threshold');
check(`failure mark — ${m['p-mark'].ratio.toFixed(2)}:1`, m['p-mark'].ratio >= 3);

console.log('\n— layout invariants');
{
  const lay = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px';
    host.innerHTML = '<div class="form"><label class="check"><input type="checkbox"><span>label</span></label><label class="check big"><input type="checkbox"><span>big</span></label><label>Field<input type="text"></label></div>';
    document.body.append(host);
    const [small, big, field] = host.querySelectorAll('label');
    const dir = (el) => getComputedStyle(el).flexDirection;
    const inline = (el) => {
      const box = el.querySelector('input');
      const txt = el.querySelector('span');
      return box.getBoundingClientRect().top - txt.getBoundingClientRect().top;
    };
    const out = { small: dir(small), big: dir(big), field: dir(field), smallOffset: Math.abs(inline(small)), bigOffset: Math.abs(inline(big)) };
    host.remove();
    return out;
  });
  check('a checkbox row lays out horizontally', lay.small === 'row', lay.small);
  check('...even the plain .check inside a stacked form', lay.smallOffset < 12, `box is ${lay.smallOffset.toFixed(0)}px off its label`);
  check('.check.big stays horizontal too', lay.big === 'row' && lay.bigOffset < 12, JSON.stringify(lay));
  check('ordinary form fields still stack label-over-input', lay.field === 'column', lay.field);
}

console.log('\n— nothing dark-theme survived');
{
  const css = await fsp.readFile(path.join(ROOT, 'desktop', 'ui', 'styles.css'), 'utf8');
  for (const dead of ['#0b0f17', '#121826', '#1a2234', '#263049', '#e8edf7', '#0a0e15', '#111726', '#2563eb']) {
    check(`the old dark value ${dead} is gone`, !css.includes(dead), '');
  }
  check('no white-on-transparent overlay tints remain', !/rgba\(255,\s*255,\s*255/.test(css), '');
  const mainSrc = await fsp.readFile(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  check('the window paints light before the page loads', /backgroundColor:\s*'#f5f7f1'/.test(mainSrc), 'else the app flashes dark on open');
}

await browser.close();
console.log(`\n══ theme: ${passed} passed, ${failed} failed ══`);
if (fails.length) { console.log('Failed:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
