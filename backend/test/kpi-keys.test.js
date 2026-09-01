/*
  kpi-keys.test.js — the KPI data-binding contract.

  index.html's department tables bind to data by KEY, not by position:
  kpi-data.js resolves each <tr class="data-row"> to a key and looks that key
  up in the /api/kpi and /api/formula/eval responses. Nothing at runtime
  reports a key that matches nothing — a renamed row label just renders "No
  data" forever, and a KPI written under a key no row carries is invisible.
  Both happened in production:

    · the 2026-08-01 "Quarry" rename moved two Mines rows from
      mines-{maintenance,operational}-cost to quarry-*, orphaning 6 months of
      real cost data that is still sitting in kpi_monthly;
    · a 'limestone-production' row reached kpi_monthly with no table row on
      any page to display it.

  So the binding is asserted statically here, with no DB and no server:

    A. every key the DB actually holds (fixtures/kpi-monthly-keys.json,
       regenerate with `npm run test:kpi-keys:snapshot`) has a row to land in;
    B. every row either has DB rows, or is computed by the formula registry,
       or is on the explicitly-acknowledged manual-only list below;
    C. keys are unique within a department (two rows sharing a key would
       silently overwrite each other on save).
*/

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { FORMULAS } = require('../../forms/formula-registry.js');

const ROOT      = path.join(__dirname, '..', '..');
const INDEX     = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const DB_KEYS   = require('./fixtures/kpi-monthly-keys.json');

/* Mines Workshop's per-equipment TARGET/ACTUAL matrix reuses .data-row with a
   completely different column meaning, has no kpi_monthly rows behind it and
   is excluded from the whole kpi-data.js pipeline (see loadManualValues) —
   excluded here for the same reason. */
const SKIP_DEPTS = ['minesworkshop'];

/* Rows that legitimately have neither DB history nor a formula: a target was
   agreed but no one has entered an actual yet. Listing them here is the point
   — an unlisted unbound row is a bug, a listed one is a known backlog item. */
const MANUAL_ONLY = new Set([
  'physical-stock-of-raw-material',   // production — no actual ever recorded
]);

/* Stored keys with no row to display them that are KNOWN and awaiting a
   business decision rather than a code fix. Each needs an owner, not a
   suppression — keep this list short and dated. */
const KNOWN_ORPHANS = new Set([
  /* mines/limestone-production — kpi_monthly id=1, the very first row ever
     written (2026-07-05, target 150 000 / actual 141 000 MT). It is NOT the
     same KPI as raising-of-hg-limestone-per-month (target 85 000), and no
     Quarry row on index.html claims it. Pending: confirm with the Quarry
     Manager whether this is a real KPI that needs a row, or a first-run test
     entry to delete. Do not guess a mapping — the two targets differ by 65 kt. */
  'mines/limestone-production',
]);

/* ── The same key resolution kpi-data.js performs at runtime ──────────── */
function kpiSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;|&ndash;/g, '-');
}
function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/* dept key → [{ key, formulaKey, label, pinned* }] for every .data-row */
function parseDeptRows(html) {
  const secRe = /<section[^>]*class="[^"]*dept-section[^"]*"[^>]*id="dept-([a-z]+)"[^>]*>/g;
  const marks = [];
  let m;
  while ((m = secRe.exec(html))) marks.push({ dept: m[1], start: m.index });
  marks.forEach((s, i) => { s.end = i + 1 < marks.length ? marks[i + 1].start : html.length; });

  const out = {};
  for (const s of marks) {
    if (SKIP_DEPTS.includes(s.dept)) continue;
    const body = html.slice(s.start, s.end);
    const rows = body.match(/<tr[^>]*class="[^"]*data-row[^"]*"[^>]*>[\s\S]*?<\/tr>/g) || [];
    out[s.dept] = rows.map(r => {
      const pinnedKpi     = r.match(/<tr[^>]* data-kpi-key="([^"]+)"/);
      const pinnedFormula = r.match(/<tr[^>]* data-formula-key="([^"]+)"/);
      const firstTd       = (r.match(/<td[^>]*>[\s\S]*?<\/td>/) || [''])[0];
      const label         = stripTags(firstTd);
      const fallback      = kpiSlug(label);
      /* Mirrors kpi-data.js's kpiKeyOf() / formulaKeyOf() exactly. */
      return {
        label,
        key:        pinnedKpi     ? pinnedKpi[1]     : fallback,
        formulaKey: pinnedFormula ? pinnedFormula[1] : fallback,
        pinnedKpi:     !!pinnedKpi,
        pinnedFormula: !!pinnedFormula,
      };
    });
  }
  return out;
}

const PAGE = parseDeptRows(INDEX);
const FORMULA_KEYS = new Set(Object.keys(FORMULAS));

test('every department section on index.html was parsed', () => {
  const expected = ['summary', 'ei', 'production', 'mines', 'mechanical', 'powerplant', 'packing', 'stores'];
  assert.deepStrictEqual(Object.keys(PAGE).sort(), expected.sort(),
    'index.html no longer has the expected dept-section ids — update this test and kpi-data.js together');
});

test('A. every kpi_monthly key in the database has a row that displays it', () => {
  const orphans = [];
  for (const [dept, keys] of Object.entries(DB_KEYS)) {
    if (SKIP_DEPTS.includes(dept)) continue;
    const pageKeys = new Set((PAGE[dept] || []).map(r => r.key));
    for (const k of keys) {
      if (pageKeys.has(k) || KNOWN_ORPHANS.has(`${dept}/${k}`)) continue;
      orphans.push(`${dept}/${k}`);
    }
  }
  assert.deepStrictEqual(orphans, [],
    'These KPI keys hold real data in kpi_monthly but no row on index.html binds to them, ' +
    'so the values can never be seen. Either add data-kpi-key="<key>" to the matching ' +
    '<tr class="data-row">, or migrate the rows to the key the page uses.');
});

test('B. every row on index.html binds to data that can exist', () => {
  const unbound = [];
  for (const [dept, rows] of Object.entries(PAGE)) {
    const dbKeys = new Set(DB_KEYS[dept] || []);
    for (const r of rows) {
      if (dbKeys.has(r.key) || FORMULA_KEYS.has(r.formulaKey) || MANUAL_ONLY.has(r.key)) continue;
      unbound.push(`${dept}/${r.key}  ("${r.label}")`);
    }
  }
  assert.deepStrictEqual(unbound, [],
    'These rows will read "No data" for every period: no kpi_monthly history, no ' +
    'formula-registry key, and not on the acknowledged MANUAL_ONLY list. Add ' +
    'data-kpi-key to point at the real key, or add the key to MANUAL_ONLY with a reason.');
});

test('C. KPI keys are unique within each department', () => {
  const dupes = [];
  for (const [dept, rows] of Object.entries(PAGE)) {
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.key)) dupes.push(`${dept}/${r.key}`);
      seen.add(r.key);
    }
  }
  assert.deepStrictEqual(dupes, [],
    'Two rows in one department resolve to the same KPI key — they would overwrite ' +
    "each other's value on save and both render the same figure.");
});

test('D. every explicitly pinned key resolves to something real', () => {
  /* Pinning is the deliberate act of overriding the label-derived default, so a
     pinned key that matches nothing is always a typo — and it fails silently,
     degrading straight back to "No data". */
  const suspicious = [];
  for (const [dept, rows] of Object.entries(PAGE)) {
    const dbKeys = new Set(DB_KEYS[dept] || []);
    for (const r of rows) {
      if (r.pinnedKpi && !dbKeys.has(r.key)) {
        suspicious.push(`${dept}: data-kpi-key="${r.key}" matches no stored kpi_monthly key`);
      }
      if (r.pinnedFormula && !FORMULA_KEYS.has(r.formulaKey)) {
        suspicious.push(`${dept}: data-formula-key="${r.formulaKey}" is not in forms/formula-registry.js`);
      }
    }
  }
  assert.deepStrictEqual(suspicious, []);
});
