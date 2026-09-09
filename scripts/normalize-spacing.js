/*
  Normalises padding / margin / gap declarations onto the 4px spacing
  scale in design-system.css.

  The consistency audit counts RENDERED elements, so a single `td` rule
  shows up eleven thousand times. The source is small: a few dozen
  declarations carrying 5, 7, 9, 13 and 18px. Every substitution below
  moves a value by at most 2px, and always toward the scale — small
  enough that no layout can depend on the difference, large enough that
  the app stops having seventeen spacing values for a five-value system.

      node scripts/normalize-spacing.js          # dry run, prints diff
      node scripts/normalize-spacing.js --write  # apply
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');

/* value → nearest scale step. Only shifts that stay within 2px, and
   ties resolve DOWNWARD so nothing can start overflowing a container
   that previously fit. */
const MAP = { 5: 4, 7: 8, 9: 8, 11: 12, 13: 12, 15: 16, 18: 16, 22: 20, 26: 24, 34: 32 };

/* Properties whose values are spacing. `border`, `width`, `top` and
   friends are deliberately absent: a 5px radius or a 7px offset is not
   a spacing-scale concern and changing them would move real geometry. */
const PROPS = /\b(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|block|inline))?\s*:\s*([^;{}]+)/gi;

const files = [];
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'e2e') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(css|html)$/i.test(e.name)) files.push(p);
  }
};
walk(ROOT);

let totalDecls = 0, totalFiles = 0;
const samples = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let changed = 0;

  const out = src.replace(PROPS, (whole, prop, _d, _s, value) => {
    /* Leave var(), calc() and anything non-numeric alone. */
    if (/var\(|calc\(|env\(/i.test(value)) return whole;
    const newValue = value.replace(/(^|[\s(])(\d+)px/g, (m, pre, n) => {
      const v = +n;
      return MAP[v] !== undefined ? pre + MAP[v] + 'px' : m;
    });
    if (newValue === value) return whole;
    changed++;
    if (samples.length < 25) {
      samples.push(`${path.relative(ROOT, file)}: ${prop}: ${value.trim()}  →  ${newValue.trim()}`);
    }
    return whole.slice(0, whole.length - value.length) + newValue;
  });

  if (changed) {
    totalDecls += changed; totalFiles++;
    if (WRITE) fs.writeFileSync(file, out);
  }
}

console.log(samples.join('\n'));
console.log(`\n${totalDecls} declarations in ${totalFiles} files` +
            (WRITE ? ' — WRITTEN' : ' — dry run, pass --write to apply'));
