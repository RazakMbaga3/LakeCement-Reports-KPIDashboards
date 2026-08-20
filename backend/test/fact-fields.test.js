/*
  test/fact-fields.test.js — cross-checks forms/formula-registry.js's FACTS
  against the real form HTML, so a fact's declared `field` silently not
  matching any real data-field="..." attribute anywhere is caught
  automatically instead of by luck during a manual audit. This exact
  failure mode has already shipped twice in this project's history — see
  formula-registry.js's own notes on the kiln_coal_cons/kiln_coal_ncv and
  pwr_cm1_kwh/pwr_packing2_kwh incidents (each silently excluded a fact
  from every KPI that used it for months before a manual grep caught it).

  Pure static check: no server, no Postgres. Scans every daily-entry HTML
  page for `data-field="X"` attributes (the convention every form uses —
  confirmed by grep) and asserts every 'manual'-source FACT's field
  appears somewhere in that set. A fact intentionally not yet wired into
  any form's HTML should not exist in the registry yet either.

  Usage: node --test test/fact-fields.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const { FACTS } = require(path.join('..', '..', 'forms', 'formula-registry.js'));

const REPO_ROOT = path.join(__dirname, '..', '..');
const CANDIDATE_FILES = [
  'daily-report.html',
  'index.html',
  'mines-report.html',
  'power-plant-report.html',
  'forms/dispatch-form.html',
  'forms/limestone-form.html',
  'forms/materials-form.html',
  'forms/pile-quality-form.html',
  'forms/power-form.html',
  'forms/quality-form.html',
  'forms/sales-projection-form.html',
  'forms/stoppage-form.html',
];

function loadCandidateSources() {
  return CANDIDATE_FILES
    .map(rel => path.join(REPO_ROOT, rel))
    .filter(p => fs.existsSync(p))
    .map(p => fs.readFileSync(p, 'utf8'));
}

/* The authoritative signal that a field is real: a literal data-field="X"
   attribute somewhere (what every form's real <input> carries, and what
   forms/form-persist.js/kpi-live.js actually read from at submit time). A
   bare word-boundary match on the field name alone is NOT enough — a
   field can appear in a purely read-side/display context (e.g.
   power-plant-report.html has data-kpi="cpp_gross_gen_kwh_ondate" and
   data-roll-mtd="cpp_gross_gen_kwh" cells with NO <input> anywhere behind
   them) and a naive scan would wrongly call that "real". */
function collectDataFields(sources) {
  const fields = new Set();
  for (const s of sources) for (const m of s.matchAll(/data-field="([^"]+)"/g)) fields.add(m[1]);
  return fields;
}

/* One confirmed exception to the data-field="X" rule: materials-form.html
   builds each coal-supplier row's field name at RUNTIME by string-
   concatenating a config-array token with a suffix (`p + '_cons'`, see
   its own `F[el.getAttribute('data-field')] = el.value` + `calc(p +
   '_cons')` wiring) — so "ck_stamico_cons" never appears as a literal
   string anywhere in the static file even though the field is real and
   working. Scoped to this one file specifically (not "any candidate
   file") so it can't accidentally validate an unrelated genuinely-missing
   field elsewhere via coincidental text. */
const MATERIALS_FORM_SUFFIXES = ['_cons', '_var'];
function isMaterialsConfigDrivenField(field, materialsSource) {
  if (!materialsSource) return false;
  for (const suffix of MATERIALS_FORM_SUFFIXES) {
    if (!field.endsWith(suffix)) continue;
    const base = field.slice(0, -suffix.length);
    const configEntry = new RegExp(`f\\s*:\\s*['"]${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
    if (configEntry.test(materialsSource)) return true;
  }
  return false;
}

test('every manual-source fact field exists as a real data-field="..." (or config-array-driven materials field)', () => {
  const sources = loadCandidateSources();
  const realFields = collectDataFields(sources);
  const materialsSource = fs.existsSync(path.join(REPO_ROOT, 'forms/materials-form.html'))
    ? fs.readFileSync(path.join(REPO_ROOT, 'forms/materials-form.html'), 'utf8') : '';

  const missing = [];
  for (const [key, f] of Object.entries(FACTS)) {
    if (f.source !== 'manual') continue; // odoo-sourced facts have no form field to check
    if (f.legacy) continue;              // superseded field kept only to read old historical rows — never on a current form
    if (f.unwired) continue;             // known, documented gap (see the fact's own comment) — tracked, not silently missing
    if (realFields.has(f.field)) continue;
    if (f.form === 'materials' && isMaterialsConfigDrivenField(f.field, materialsSource)) continue;
    missing.push(`${key} -> field "${f.field}" (form: ${f.form})`);
  }
  assert.equal(missing.length, 0,
    `${missing.length} fact(s) reference a form field that doesn't exist anywhere in the scanned HTML/JS:\n  ` +
    missing.join('\n  '));
});

test('facts flagged unwired are still actually missing (catches a stale flag after the real fix lands)', () => {
  const sources = loadCandidateSources();
  const realFields = collectDataFields(sources);
  const materialsSource = fs.existsSync(path.join(REPO_ROOT, 'forms/materials-form.html'))
    ? fs.readFileSync(path.join(REPO_ROOT, 'forms/materials-form.html'), 'utf8') : '';

  const staleFlags = [];
  for (const [key, f] of Object.entries(FACTS)) {
    if (!f.unwired) continue;
    const nowReal = realFields.has(f.field) ||
      (f.form === 'materials' && isMaterialsConfigDrivenField(f.field, materialsSource));
    if (nowReal) staleFlags.push(`${key} -> field "${f.field}" now exists on a form — remove its unwired:true flag`);
  }
  assert.equal(staleFlags.length, 0, staleFlags.join('\n  '));
});
