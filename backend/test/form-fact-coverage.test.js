/*
  form-fact-coverage.test.js — can each form actually CAPTURE the fields its
  own KPIs are computed from?

  fact-fields.test.js already asserts that every manual FACT's declared field
  exists as a data-field="…" somewhere in the repo. That is a spelling check:
  it pools every candidate page into one set, so a field belonging to form
  type A satisfies a fact declared against form type B.

  It therefore missed the real defect it was written for. power-plant-report.html
  used to be a read-only report — 22 CPP metrics rendered from stored data
  through data-kpi / data-roll-mtd cells, with only `date` and `prepared_by`
  bound to actual inputs — yet wired to initFormPersist('cpp') with Save Draft
  and Submit buttons. cpp-heat-rate and cpp-auxiliary-power are computed from
  (cpp_heat_rate_plant, cpp_gross_gen_kwh, cpp_aux_kwh), which existed on that
  page only as read-side display attributes, so the form could never produce
  them. Before the submit route was changed to merge rather than replace, one
  click of Submit also wiped all 22 stored fields for that day. The "On Date"
  column became real inputs on 2026-09-04; this test is what keeps it that way.

  This test binds each fact to the page that actually submits its form type —
  discovered from the page's own initFormPersist('…') call, so the mapping
  cannot drift from what ships.
*/

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { FACTS } = require('../../forms/formula-registry.js');

const ROOT = path.join(__dirname, '..', '..');

/* Pages that a form type could be entered on. Scanned for their own
   initFormPersist('…') call rather than hardcoding the pairing. */
const FORM_PAGES = [
  'daily-report.html', 'power-plant-report.html', 'mines-report.html',
  'forms/dispatch-form.html', 'forms/limestone-form.html', 'forms/materials-form.html',
  'forms/pile-quality-form.html', 'forms/power-form.html', 'forms/quality-form.html',
  'forms/sales-projection-form.html', 'forms/stoppage-form.html',
];

/* Fields a page builds at RUNTIME, so they never appear as a literal
   data-field="…" in the static file. Each entry needs a reason, and the
   pattern is verified against the page's own config rather than assumed. */
const RUNTIME_FIELD_SOURCES = {
  /* materials-form.html names each material's inputs by concatenating a
     config token with a suffix (`F[el.getAttribute('data-field')]` +
     `calc(p + '_cons')`), so e.g. "ck_stamico_cons" is never a literal.
     Same exception backend/test/fact-fields.test.js documents. */
  'forms/materials-form.html': /\bf\s*:\s*['"]([a-z0-9_]+)['"]/gi,
};

/* Form types whose data has NO entry page yet, acknowledged rather than
   silently tolerated. Each needs an owner and a plan, not a suppression. */
const NO_ENTRY_FORM = {
  /* Empty since 2026-09-04. The one entry here was `cpp`: all 91 stored days
     had arrived through an import and there was no screen a CPP officer
     could type tomorrow's readings into. power-plant-report.html's "On Date"
     column is now 22 real inputs, so CPP is checked by the test below like
     every other form type. */
};

function readPage(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/* formType → { page, fields } for every page that submits through
   form-persist.js. */
function buildPageIndex() {
  const byFormType = {};
  for (const rel of FORM_PAGES) {
    const src = readPage(rel);
    if (!src) continue;
    const m = src.match(/initFormPersist\('([^']+)'\)/);
    if (!m) continue;                       // page doesn't submit (mines-report.html)
    const fields = new Set([...src.matchAll(/data-field="([^"]+)"/g)].map(x => x[1]));
    const runtime = RUNTIME_FIELD_SOURCES[rel];
    if (runtime) {
      for (const r of src.matchAll(runtime)) {
        for (const suffix of ['', '_cons', '_var', '_open', '_close', '_recv']) fields.add(r[1] + suffix);
      }
    }
    byFormType[m[1]] = { page: rel, fields };
  }
  return byFormType;
}

const PAGES = buildPageIndex();

test('every form type a page submits is a known page/form pairing', () => {
  assert.ok(Object.keys(PAGES).length >= 9,
    'expected at least 9 pages wired to initFormPersist — found ' + Object.keys(PAGES).length);
  assert.equal(PAGES.cpp && PAGES.cpp.page, 'power-plant-report.html');
  assert.equal(PAGES.production && PAGES.production.page, 'daily-report.html');
});

test('each form can capture every fact its own KPIs are computed from', () => {
  /* factsByForm[formType] = [field, …] for the manual (form-entered) facts */
  const factsByForm = {};
  for (const [key, f] of Object.entries(FACTS)) {
    if (f.source && f.source !== 'manual') continue;
    /* `legacy: true` marks a fact that reads a field name only OLD rows
       carry — the pre-channel-split dispatch fields, kept purely as a
       fallback in despatch-day's daily(). The current form is not expected
       to produce them, and the registry says so itself. */
    if (f.legacy) continue;
    (factsByForm[f.form] || (factsByForm[f.form] = [])).push({ key, field: f.field });
  }

  const gaps = [];
  for (const [formType, facts] of Object.entries(factsByForm)) {
    if (NO_ENTRY_FORM[formType]) continue;
    const page = PAGES[formType];
    if (!page) {
      gaps.push(`${formType}: no page submits this form type, but ${facts.length} fact(s) read it`);
      continue;
    }
    const missing = facts.filter(f => !page.fields.has(f.field));
    if (missing.length) {
      gaps.push(`${page.page} (form "${formType}") cannot capture: ` +
        missing.map(f => `${f.field} [fact ${f.key}]`).join(', '));
    }
  }

  assert.deepStrictEqual(gaps, [],
    'A KPI is computed from a field its own entry form has no input for, so the ' +
    'value can only ever arrive by import. Add the input, or list the form type in ' +
    'NO_ENTRY_FORM with the reason and the owner.');
});

test('the acknowledged no-entry list stays honest', () => {
  /* A form type listed as having no entry page must still HAVE a page wired
     to submit it — otherwise the entry is stale and should be deleted. */
  for (const formType of Object.keys(NO_ENTRY_FORM)) {
    assert.ok(PAGES[formType],
      `NO_ENTRY_FORM lists "${formType}" but no page submits it any more — remove the entry.`);
  }
});

test('every writer of daily_reports sets status explicitly', () => {
  /* daily_reports.status DEFAULTS to 'draft' (migration 010), and everything
     that reads the table for analysis now ignores drafts (REPORTED_STATUSES
     in config/forms.js). So an INSERT that leaves status to the default
     silently makes its rows invisible to the KPI engine, the MIS pack and
     Entry Completeness. services/odooDispatchSync.js did exactly that —
     every ERP-synced dispatch day would have vanished from the reports. */
  const dir = path.join(__dirname, '..');
  const offenders = [];

  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const full = path.join(d, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });

  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/INSERT INTO daily_reports\s*\(([^)]*)\)/gi)) {
      if (!/\bstatus\b/i.test(m[1])) offenders.push(path.relative(dir, file));
    }
  }

  assert.deepStrictEqual([...new Set(offenders)], [],
    'These files INSERT INTO daily_reports without naming the status column, so ' +
    "their rows default to 'draft' and never reach any report. Set it explicitly.");
});
