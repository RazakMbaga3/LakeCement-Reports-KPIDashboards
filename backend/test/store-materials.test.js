/*
  test/store-materials.test.js — keeps backend/config/storeMaterials.js in
  step with the material list the entry form actually renders
  (forms/materials-form.html's MATERIALS_SECTIONS).

  The two lists exist separately only because the form's copy is inline in
  HTML and can't be require()d from Node. That duplication is exactly the
  kind that rots silently: add a coal supplier to the form and, with no
  check, it just quietly never appears in the Stores dashboard — the same
  failure mode fact-fields.test.js exists to catch for the formula
  registry (see its header for the two incidents that motivated it).

  Pure static check: no server, no Postgres. The form's section array is
  extracted by evaluating just that literal out of the HTML, so this
  compares against what the form really declares, not a second hand-copy.

  Usage: node --test test/store-materials.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { SECTIONS, ROWS, CATEGORIES } = require('../config/storeMaterials');

const FORM_PATH = path.join(__dirname, '..', '..', 'forms', 'materials-form.html');

/* Pull `const MATERIALS_SECTIONS = [...];` out of the form and evaluate
   that one array literal in an empty sandbox. */
function formSections() {
  const html = fs.readFileSync(FORM_PATH, 'utf8');
  const start = html.indexOf('const MATERIALS_SECTIONS = [');
  assert.notEqual(start, -1, 'MATERIALS_SECTIONS literal not found in materials-form.html');
  const open = html.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, 'Could not find the end of the MATERIALS_SECTIONS literal');
  const foreign = vm.runInNewContext('(' + html.slice(open, end + 1) + ')');
  /* The sandbox has its own Array/Object prototypes, so values crossing
     back fail assert.deepEqual on realm identity alone. Round-trip through
     JSON to get plain values in this realm. */
  return JSON.parse(JSON.stringify(foreign));
}

test('every form material exists in the backend store config', () => {
  const formRows = formSections().flatMap(sec => sec.rows.map(r => r.f));
  const configFields = new Set(ROWS.map(r => r.f));
  const missing = formRows.filter(f => !configFields.has(f));
  assert.deepEqual(missing, [],
    'These materials are entered on the form but absent from config/storeMaterials.js, ' +
    'so they are silently missing from the Stores dashboard: ' + missing.join(', '));
});

test('every backend store material exists on the form', () => {
  const formFields = new Set(formSections().flatMap(sec => sec.rows.map(r => r.f)));
  const extra = ROWS.map(r => r.f).filter(f => !formFields.has(f));
  assert.deepEqual(extra, [],
    'These materials are in config/storeMaterials.js but no longer on the form, ' +
    'so they will always read zero: ' + extra.join(', '));
});

test('closing-stock flags (consOnly / pair / tank) match the form', () => {
  const formByField = new Map();
  for (const sec of formSections()) {
    for (const r of sec.rows) formByField.set(r.f, r);
  }
  const mismatches = [];
  for (const row of ROWS) {
    const f = formByField.get(row.f);
    if (!f) continue; // covered by the test above
    if (Boolean(f.consOnly) !== Boolean(row.consOnly)) mismatches.push(row.f + '.consOnly');
    if (Boolean(f.tank) !== Boolean(row.tank)) mismatches.push(row.f + '.tank');
    if ((f.pair || null) !== (row.pair || null)) mismatches.push(row.f + '.pair');
  }
  assert.deepEqual(mismatches, [],
    'These flags drive the closing-stock arithmetic, so a mismatch makes the dashboard ' +
    'disagree with the form the numbers were typed into: ' + mismatches.join(', '));
});

test('every material maps to a declared reporting category', () => {
  const unknown = ROWS.filter(r => !CATEGORIES[r.category]).map(r => r.f + ' -> ' + r.category);
  assert.deepEqual(unknown, [], 'Unknown category: ' + unknown.join(', '));
});

test('sections carry the same field order as the form', () => {
  /* Order matters for the diesel section specifically: the Plant main
     tank absorbs the whole section's consumption, so a row landing in the
     wrong section would silently change every diesel closing balance. */
  const formSectionIds = formSections().map(s => s.id);
  const configSectionIds = SECTIONS.map(s => s.id);
  assert.deepEqual(configSectionIds, formSectionIds,
    'Section ids/order drift between the form and config/storeMaterials.js');
});
