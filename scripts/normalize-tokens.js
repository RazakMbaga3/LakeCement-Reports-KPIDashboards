/*
  Collapses corner radii and duplicate status tints onto the tokens in
  design-system.css.

  RADII — the audit found sixteen distinct values rendering across 24
  pages for a system that declares four. 3, 4, 5, 7 and 8px were all
  doing the job of --r-sm; 10 and 12 the job of --r-md and --r-lg; and
  the 20px "pills" were pills, so they belong at --r-pill. Radius does
  not affect layout, so this cannot reflow anything — it is purely the
  difference between a system and a habit.

  STATUS TINTS — worse, because it is meaning and not just polish. The
  app was painting "good" in five different greens (#F0FDF4, #BBF7D0,
  #DCFCE7, #ECFDF5 and the actual token #E7F5ED), "bad" in four reds and
  "warn" in three ambers, all Tailwind pastels pasted in over time. A
  reader cannot learn a colour that has five values, and several of the
  pastels are too light to carry their own border. These map onto the
  status tokens, which are the ones with measured contrast.

  Deliberately NOT touched: the chart series palette (validated, and
  re-ordering it breaks CVD spacing), the brand hexes, and the cell-type
  tints in forms.css (--m-bg / --s-bg / --f-bg) which are provenance,
  not status, and are supposed to differ from it.

      node scripts/normalize-tokens.js          # dry run
      node scripts/normalize-tokens.js --write
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');

const RADIUS = { 3: 6, 4: 6, 5: 6, 7: 6, 8: 6, 10: 9, 11: 9, 12: 14, 13: 14, 16: 14, 20: 999 };

/* Tailwind-era pastels → the measured status tokens. Keys are lowercase. */
const TINT = {
  '#f0fdf4': 'var(--st-good-bg)', '#dcfce7': 'var(--st-good-bg)',
  '#ecfdf5': 'var(--st-good-bg)', '#e8f5ec': 'var(--st-good-bg)',
  '#e8f5ee': 'var(--st-good-bg)', '#d1fae5': 'var(--st-good-bg)',
  '#bbf7d0': 'var(--st-good-bd)', '#a7f3d0': 'var(--st-good-bd)',
  '#b7e4c7': 'var(--st-good-bd)', '#bbeed6': 'var(--st-good-bd)',

  '#fef3c7': 'var(--st-warn-bg)', '#fffbeb': 'var(--st-warn-bg)',
  '#fff3e0': 'var(--st-warn-bg)', '#fffdf5': 'var(--st-warn-bg)',
  '#fde68a': 'var(--st-warn-bd)', '#fcd34d': 'var(--st-warn-bd)',
  '#fbd3a0': 'var(--st-warn-bd)', '#fde8cc': 'var(--st-warn-bd)',

  '#ffebee': 'var(--st-bad-bg)',  '#fef2f2': 'var(--st-bad-bg)',
  '#fff0f0': 'var(--st-bad-bg)',  '#fdecea': 'var(--st-bad-bg)',
  '#fffafa': 'var(--st-bad-bg)',
  '#fecaca': 'var(--st-bad-bd)',  '#fca5a5': 'var(--st-bad-bd)',
  '#f5c6c6': 'var(--st-bad-bd)',  '#ffcdd2': 'var(--st-bad-bd)',
};

/* forms.css owns the provenance tints and must keep its own values. */
const TINT_SKIP = new Set([path.join(ROOT, 'forms', 'forms.css')]);

const RADIUS_PROP = /\bborder(-[a-z]+)?-radius\s*:\s*([^;{}]+)/gi;
const HEX = /#[0-9a-fA-F]{6}\b/g;

/* backend/ is excluded on purpose: digest.js, misExcel.js and
   misRender.js emit e-mail HTML and Excel cell fills, and neither an
   e-mail client nor a spreadsheet resolves a CSS custom property. Those
   hexes have to stay literal. */
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'e2e', 'backend', 'scripts'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(css|html|js)$/i.test(e.name)) files.push(p);
  }
})(ROOT);

let rad = 0, tint = 0, touched = 0;
const samples = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let out = src, n = 0;

  out = out.replace(RADIUS_PROP, (whole, _side, value) => {
    if (/var\(|calc\(|%/i.test(value)) return whole;
    const nv = value.replace(/(^|[\s(])(\d+)px/g, (m, pre, num) => {
      const v = +num;
      if (RADIUS[v] === undefined) return m;
      return pre + (RADIUS[v] === 999 ? '999px' : RADIUS[v] + 'px');
    });
    if (nv === value) return whole;
    rad++; n++;
    if (samples.length < 12) samples.push(`${path.relative(ROOT, file)}: radius ${value.trim()} → ${nv.trim()}`);
    return whole.slice(0, whole.length - value.length) + nv;
  });

  if (!TINT_SKIP.has(file)) {
    out = out.replace(HEX, (h, offset, whole) => {
      const rep = TINT[h.toLowerCase()];
      if (!rep) return h;
      /* Never rewrite the right-hand side of a custom-property
         DEFINITION: `--st-bad-bg: #FDECEA` became
         `--st-bad-bg: var(--st-bad-bg)`, a circular reference that
         resolves to nothing and silently unsets the token everywhere. */
      const lineStart = whole.lastIndexOf('\n', offset) + 1;
      if (/--[A-Za-z0-9-]+\s*:\s*$/.test(whole.slice(lineStart, offset))) return h;
      tint++; n++;
      if (samples.length < 24) samples.push(`${path.relative(ROOT, file)}: tint ${h} → ${rep}`);
      return rep;
    });
  }

  if (n) { touched++; if (WRITE) fs.writeFileSync(file, out); }
}

console.log(samples.join('\n'));
console.log(`\n${rad} radius + ${tint} tint substitutions in ${touched} files` +
            (WRITE ? ' — WRITTEN' : ' — dry run, pass --write to apply'));
