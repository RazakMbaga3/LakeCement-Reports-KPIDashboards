/*
  White text on Nyati orange is 2.27:1. design-system.css already corrects
  it — but through a hardcoded list of selectors (.btn-save, #login-btn,
  .tb-apply, …), which is the same shape of mistake that hid 157px of the
  admin table behind a class-name list. Every orange fill somebody added
  afterwards escaped it: the Excel and Send-digest buttons on
  reports-export, the offline-queue sync button, the Excel-import Apply
  button, the selected date cell and totals row on the quarry report.

  This corrects them AT SOURCE instead, so the override list stops being
  the thing holding the line. Line-scoped on purpose: a colour is only
  rewritten on a line that also paints a brand-orange background, so a
  white label on any other ground is untouched.

      node scripts/fix-on-orange.js          # dry run
      node scripts/fix-on-orange.js --write
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');

/* backend/ emits e-mail HTML and Excel fills, where a CSS custom property
   means nothing — those stay literal and are handled separately. */
const SKIP = new Set(['node_modules', '.git', 'e2e', 'backend', 'scripts']);

const ORANGE = /background(?:-color)?:\s*(?:var\(--orange[^)]*\)|#F49545)/i;
const WHITE  = /color:\s*(?:white|#fff|#ffffff)\b/ig;

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(css|html|js)$/i.test(e.name)) files.push(p);
  }
})(ROOT);

let hits = 0, touched = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!ORANGE.test(lines[i])) continue;
    WHITE.lastIndex = 0;
    if (!WHITE.test(lines[i])) continue;
    WHITE.lastIndex = 0;
    lines[i] = lines[i].replace(WHITE, 'color:var(--on-orange)');
    n++;
    console.log(`  ${path.relative(ROOT, file)}:${i + 1}`);
  }
  if (n) { hits += n; touched++; if (WRITE) fs.writeFileSync(file, lines.join('\n')); }
}
console.log(`\n${hits} declaration(s) in ${touched} file(s)` +
            (WRITE ? ' — WRITTEN' : ' — dry run, pass --write to apply'));
