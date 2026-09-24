/*
  test/excel-extractors.test.js — the first automated cover for
  forms/excel-import.js, the "Import Excel" button behind ten entry forms.

  WHY IT EXISTS
  -------------
  That file is ~1400 lines of column arithmetic against nine different
  plant workbooks, and until now nothing tested it. It shipped with
  `window._nyatiExtractors = EXTRACTORS` and the comment "Exposed so
  extractors can be exercised outside the page (tests)" — and no test
  ever called it. Writing this one immediately turned up three real
  defects, all of them silent:

    * materials: read one column too far right on every real RAW
      MATERIAL REPORT (their used range starts at column B), so a valid
      file produced "0 fields matched" and Apply did nothing;
    * dispatch:  took the date from the cell ABOVE the "DATE" label,
      which holds the next day — so the preview's wrong-day warning
      fired on every correct import;
    * pile-quality: had no shape check at all, so a Power Consumption
      report dropped on the Pile Quality form filled all 18 CaO boxes
      with kWh readings and said nothing.

  HOW IT DRIVES BROWSER CODE FROM NODE
  ------------------------------------
  excel-import.js is an IIFE that wants `window`, `document`,
  `localStorage` and a global `XLSX`. Rather than refactor 1400 lines
  into a dual-runtime module (the forms/formula-registry.js pattern),
  it is evaluated as-is inside a `vm` context holding ~30 lines of
  stubs; its bootstrap then no-ops because window._nyatiFormId is
  unset, and `_nyatiExtractors` is lifted straight back out. The
  extractors under test are therefore the exact bytes the browser runs,
  not a copy.

  ZERO NEW DEPENDENCIES
  ---------------------
  SheetJS comes from vendor/xlsx-0.18.5/xlsx.full.min.js — the same file
  the browser now loads. (`xlsx` is NOT in backend/package.json; the
  copy scripts/import-stoppage-facts.js resolves lives in an untracked
  repo-root node_modules, so CI could not rely on it.) Driving the
  vendored bundle here doubles as proof that the vendored copy is a
  working SheetJS, not just bytes of the right size.

  FIXTURES are real plant workbooks already committed to this repo. Every
  hard-coded expectation below was read out of the workbook cell by cell
  before being written down; the spot checks name the cell they came from.

  Usage: node --test test/excel-extractors.test.js   (from backend/)
*/

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');
const path   = require('path');
const crypto = require('crypto');

const REPO   = path.join(__dirname, '..', '..');
const VENDOR = path.join(REPO, 'vendor', 'xlsx-0.18.5', 'xlsx.full.min.js');

/* sha256 of xlsx@0.18.5's published dist/xlsx.full.min.js. Established by
   downloading the npm tarball, checking it against the registry's own
   sha512, and confirming cdn.jsdelivr.net and cdnjs serve identical bytes.
   If this ever fails, the vendored library has been altered — do not
   "update the constant", find out why. */
const XLSX_SHA256 = 'c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99';

const XLSX = require(VENDOR);

/* ── Harness ────────────────────────────────────────────────────────── */

function stubEl() {
  return {
    value: '', style: {}, dataset: {}, className: '', id: '', innerHTML: '',
    appendChild() {}, insertBefore() {}, addEventListener() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    dispatchEvent() { return true; }, setAttribute() {}, getAttribute() { return null; },
  };
}

/* Evaluates forms/excel-import.js and hands back its EXTRACTORS map.
   opts.reasons  -> seeds localStorage['nyati-stoppage-reasons']
   opts.formDate -> value of the page's [data-field="date"] input
   opts.materials-> attaches window.MATERIALS_SECTIONS from the form page */
function loadExtractors(opts = {}) {
  const src   = fs.readFileSync(path.join(REPO, 'forms', 'excel-import.js'), 'utf8');
  const store = opts.reasons ? { 'nyati-stoppage-reasons': JSON.stringify(opts.reasons) } : {};
  const dateEl = opts.formDate ? { value: opts.formDate } : null;

  const document = {
    readyState: 'complete',
    currentScript: { src: 'http://localhost/forms/excel-import.js' },
    head: stubEl(), body: stubEl(),
    createElement: stubEl,
    getElementById: () => null,
    querySelector: (sel) => (sel === '[data-field="date"]' ? dateEl : null),
    querySelectorAll: () => [],
    addEventListener() {}, dispatchEvent() { return true; },
  };
  const sandbox = {
    XLSX, document, console, URL, setTimeout,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {} },
    alert() {}, Event: class {}, CustomEvent: class {},
  };
  sandbox.window = sandbox;           /* the file reads both `window.x` and bare globals */
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'forms/excel-import.js' });

  if (opts.materials) sandbox.MATERIALS_SECTIONS = materialsSections(sandbox);

  assert.ok(sandbox.window._nyatiExtractors, 'window._nyatiExtractors was not exposed');
  return sandbox.window._nyatiExtractors;
}

/* The materials extractor refuses to run without the row catalogue the
   form page defines, so the test lifts the real one out of the page —
   if form and importer ever drift apart, this test sees it. */
function materialsSections(sandbox) {
  const html = fs.readFileSync(path.join(REPO, 'forms', 'materials-form.html'), 'utf8');
  const m = html.match(/MATERIALS_SECTIONS\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  assert.ok(m, 'MATERIALS_SECTIONS not found in forms/materials-form.html');
  return vm.runInContext('(' + m[1] + ')', sandbox);
}

/* The governed stoppage reason catalogue, in the {id, equipment, cause,
   label} shape forms/stoppage-reasons.js caches in localStorage. Read from
   migration 017, which seeded it verbatim from the same workbook this test
   feeds the extractor — ids are the SERIAL values, i.e. insert order. */
function stoppageReasons() {
  const sql   = fs.readFileSync(
    path.join(REPO, 'backend', 'db', 'migrations', '017_stoppage_reasons.sql'), 'utf8');
  const start = sql.indexOf('INSERT INTO stoppage_reasons');
  assert.ok(start >= 0, 'migration 017 has no stoppage_reasons INSERT');
  const body  = sql.slice(sql.indexOf('VALUES', start) + 6);
  const re    = /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*(\d+)\s*\)/g;
  const out   = [];
  let m;
  while ((m = re.exec(body))) {
    out.push({
      id: out.length + 1,
      equipment: m[1].replace(/''/g, "'"),
      cause:     m[2].replace(/''/g, "'"),
      label:     m[3].replace(/''/g, "'"),
    });
  }
  return out;
}

/* Reads a fixture the way the browser does: bytes -> XLSX.read(..,'array'). */
function workbook(rel) {
  const file = path.join(REPO, rel);
  assert.ok(fs.existsSync(file), 'fixture missing: ' + rel);
  return XLSX.read(new Uint8Array(fs.readFileSync(file)), { type: 'array' });
}

/* ── Fixtures (all already committed to this repo) ──────────────────── */
const FIX = {
  dispatchApr:  'data/samples/2026-04-21/2. Dispatch & Stoppage report  21.4.2026 (2).xlsx',
  dispatchAug:  'FW_ MIS REPORT 30.08.2026/2. Dispatch & Stoppage report 30.8.2026.xlsx',
  qcDaily:      'data/samples/2026-04-21/QC DAILY REPORT.xlsx',
  qualityApr:   'data/samples/2026-04-21/6. Quality Report 21.04.2026 (2).xlsx',
  materialsApr: 'data/samples/2026-04-21/7. Materials Report 21.04.2026 (2).xlsx',
  materialsAug: 'FW_ MIS REPORT 30.08.2026/7. Materials Report 30.08.2026.xlsx',
  powerApr:     'data/samples/2026-04-21/8. Power consumption report 21.04.2026 (2).xlsx',
  powerSep:     '20.09.2026.xlsx',
  cppApr:       'data/samples/2026-04-21/4. CPP Report 21.04.2026 (2).xlsx',
  cppAug:       'FW_ MIS REPORT 30.08.2026/4. CPP Report 30.08.2026.xlsx',
  prodApr:      '1. Production Report 21.04.2026 (1).xlsx',
  prodAug:      'FW_ MIS REPORT 30.08.2026/1. Production Report 30.08.2026.xlsx',
  prodJul:      'Production Report 01.07.2026.xlsx',
  stoppageApr:  '3. Stoppage report 21.04.2026 (1).xlsx',
  stoppageAprM: 'master stoppage reports/Stoppage report 30.04.2026.xlsx',
  stoppageAug:  'FW_ MIS REPORT 30.08.2026/3. Stoppage report 30.08.2026.xlsx',
  pileMay:      '5-Pile Quality report-May-2026.xlsx',
  limestone:    'LIMESTONE %.xlsx',
};

/* Every extractor keeps its own sandbox: the stoppage one needs a form
   date and a reason catalogue, the materials one needs a row catalogue,
   and mixing them would let one test's state mask another's bug. */
const EX = loadExtractors();

const filled = (out) => Object.keys(out).filter(k => k !== 'date' && out[k] !== '').length;

/* ══════════════════════════════════════════════════════════════════════
   0. The vendored library itself
   ══════════════════════════════════════════════════════════════════════ */
test('vendored SheetJS is the published xlsx@0.18.5 browser build', () => {
  const bytes = fs.readFileSync(VENDOR);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), XLSX_SHA256);
  assert.equal(XLSX.version, '0.18.5');
  assert.equal(typeof XLSX.utils.sheet_to_json, 'function');
});

test('both Excel loaders prefer the local copy over the CDN', () => {
  /* Regression guard for the actual production risk: the plant network
     has no internet egress, so a CDN-first (or CDN-only) loader means
     every Import/Export button on site fails. */
  const importer = fs.readFileSync(path.join(REPO, 'forms', 'excel-import.js'), 'utf8');
  const exporter = fs.readFileSync(path.join(REPO, 'forms', 'excel-export.js'), 'utf8');
  const mines    = fs.readFileSync(path.join(REPO, 'mines-report.html'), 'utf8');
  for (const [name, src] of [['excel-import.js', importer], ['excel-export.js', exporter], ['mines-report.html', mines]]) {
    assert.match(src, /vendor\/xlsx-0\.18\.5\/xlsx\.full\.min\.js/, name + ' does not reference the vendored copy');
    const vendorAt = src.indexOf('vendor/xlsx-0.18.5');
    const cdnAt    = src.indexOf('cdn.jsdelivr.net');
    assert.ok(cdnAt === -1 || vendorAt < cdnAt, name + ' still reaches for the CDN first');
  }
});

/* ══════════════════════════════════════════════════════════════════════
   1. Dispatch
   ══════════════════════════════════════════════════════════════════════ */
test('dispatch: April 2026 workbook', () => {
  const out = EX.dispatch(workbook(FIX.dispatchApr));
  assert.equal(out._error, undefined);
  /* Sheet "21.4.2026", row "SALES ON DATE": 42.5R = 346.5, 42.5N B-M = 30,
     everything else 0; row "SO PENDENCY": 42.5R = 4132, 32.5N = 154, and
     the bulker columns 30 + 60 that so_bulker sums. */
  assert.equal(out.dispatch_reg_425r,   '346.5');
  assert.equal(out.dispatch_reg_425nbm, '30');
  assert.equal(out.dispatch_reg_425n,   '0');
  assert.equal(out.dispatch_clinker,    '0');
  assert.equal(out.so_425r,             '4132');
  assert.equal(out.so_325n,             '154');
  assert.equal(out.so_bulker,           '90');
});

test('dispatch: August 2026 workbook', () => {
  const out = EX.dispatch(workbook(FIX.dispatchAug));
  assert.equal(out._error, undefined);
  assert.equal(out.dispatch_reg_425r,   '1478.25');
  assert.equal(out.dispatch_reg_425nbm, '516');
  assert.equal(out.dispatch_reg_325n,   '120');
  assert.equal(out.dispatch_blk_425nbm, '89.64');
  assert.equal(out.so_425r,             '4948');
});

test('dispatch: report date is the day beside the DATE label, not the day above it', () => {
  /* Both workbooks carry a second date serial one row ABOVE the labelled
     one, always report-date + 1. Reading that instead made the preview
     modal warn "this file is for <tomorrow>" on every valid import, which
     is how a real wrong-day import would have gone unnoticed. */
  assert.equal(EX.dispatch(workbook(FIX.dispatchApr)).date, '2026-04-21');
  assert.equal(EX.dispatch(workbook(FIX.dispatchAug)).date, '2026-08-30');
});

test('dispatch: rejects a workbook that is not a dispatch report', () => {
  for (const f of [FIX.stoppageApr, FIX.cppApr, FIX.prodApr, FIX.qcDaily]) {
    assert.equal(EX.dispatch(workbook(f))._error,
      'Could not find "Sales on Date" row. Is this a Dispatch report?');
  }
});

/* ══════════════════════════════════════════════════════════════════════
   2. Quality / Lab
   ══════════════════════════════════════════════════════════════════════ */
test('quality: QC DAILY REPORT workbook', () => {
  const out = EX.quality(workbook(FIX.qcDaily));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-09-21');
  assert.equal(out.blaine_425r,   '365');     /* Cement mill-1, G - 42.5R, Blaine */
  assert.equal(out.strength_28d,  '48.02');   /* ...and its 28-day strength */
  assert.equal(out.coal_gcv_adb,  '5973');    /* DAY AVERAGE FINE COAL */
  assert.equal(out.free_lime,     '3.15');    /* clinker F.CaO, mean of the six 4-hourly rows */
  assert.equal(out.lsf_rm,        '104.69');
  assert.ok(filled(out) > 50, 'expected a substantial fill, got ' + filled(out));
});

test('quality: the April daily Quality Report workbook', () => {
  const out = EX.quality(workbook(FIX.qualityApr));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-04-21');
  assert.equal(out.blaine_425r,  '358');
  assert.equal(out.strength_28d, '49.45');
  assert.equal(out.free_lime,    '3.25');
  assert.equal(out.ltrwt_ck,     '1265.8');
  assert.equal(out.c3s_ck,       '61.01');
});

test('quality: rejects a workbook with no lab tables', () => {
  for (const f of [FIX.dispatchApr, FIX.cppApr, FIX.powerApr, FIX.materialsApr]) {
    assert.equal(EX.quality(workbook(f))._error,
      'No "PHYSICAL LAB REPORT" or four-hourly chemistry tables found. Is this a QC Daily Report?');
  }
});

/* ══════════════════════════════════════════════════════════════════════
   3. Raw Materials
   ══════════════════════════════════════════════════════════════════════ */
test('materials: April 2026 workbook fills the whole sheet', () => {
  const ex  = loadExtractors({ materials: true });
  const out = ex.materials(workbook(FIX.materialsApr));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-04-21');
  /* Sheet "21.04.2026" row 1, IRON ORE: opening 4479.45, received-on-date 0,
     consumed 47, MTD/YTD 932, pending GRN 0, min 3000, max 6000. */
  assert.equal(out.iron_ore_open,     '4479.45');
  assert.equal(out.iron_ore_rcvd,     '0');
  assert.equal(out.iron_ore_cons,     '47');
  assert.equal(out.iron_ore_cons_mtd, '932');
  assert.equal(out.iron_ore_min,      '3000');
  assert.equal(out.iron_ore_max,      '6000');
  assert.equal(out.gypsum_rcvd,       '22.96');
  assert.equal(out.clinker_grn,       '178.76');
  /* Before the column-offset fix this whole workbook yielded nothing. */
  assert.ok(filled(out) > 300, 'expected hundreds of fields, got ' + filled(out));
});

test('materials: August 2026 workbook', () => {
  const ex  = loadExtractors({ materials: true });
  const out = ex.materials(workbook(FIX.materialsAug));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-08-30');
  assert.equal(out.iron_ore_cons, '84');
  assert.equal(out.clinker_rcvd,  '2010');
  assert.ok(filled(out) > 300, 'expected hundreds of fields, got ' + filled(out));
});

test('materials: refuses to run without the form page row catalogue', () => {
  assert.equal(EX.materials(workbook(FIX.materialsApr))._error,
    'Row catalogue missing — open this import from the Raw Materials form page.');
});

test('materials: rejects other workbooks, including ones that share its headers', () => {
  const ex = loadExtractors({ materials: true });
  const msg = 'This does not look like a "RAW MATERIAL REPORT" sheet (no such title, or no DESCRIPTION column). Is this the Raw Materials workbook?';
  /* The Production and CPP reports also have a DESCRIPTION column and
     also list clinker/GYPSUM/LIMESTONE, so a header check alone let a
     Production report half-fill this form. */
  for (const f of [FIX.prodApr, FIX.prodAug, FIX.cppApr, FIX.dispatchApr, FIX.pileMay]) {
    assert.equal(ex.materials(workbook(f))._error, msg);
  }
});

/* ══════════════════════════════════════════════════════════════════════
   4. Power Consumption
   ══════════════════════════════════════════════════════════════════════ */
test('power-cons: April 2026 workbook', () => {
  const out = EX['power-cons'](workbook(FIX.powerApr));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-04-21');
  /* Sheet "Power Report ": Lime Stone Crusher section Total = 1624.19 kWh
     against 3182 MT; Rawmill section splits RM-1 / RM-2. */
  assert.equal(out.pwr_crusher_kwh,     '1624.19');
  assert.equal(out.pwr_crusher_prod_mt, '3182.00');
  assert.equal(out.pwr_rawmill_prod_mt, '1824.00');
  assert.equal(out.pwr_rawmill2_kwh,    '6721.09');
  assert.equal(out.pwr_kiln_prod_mt,    '1210.00');
});

test('power-cons: September 2026 workbook (the rebuilt section map)', () => {
  const out = EX['power-cons'](workbook(FIX.powerSep));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-09-20');
  /* These four are precisely the sections the pre-2026-09-22 version
     skipped: Cement Mill-1, Packing, Plant Lighting and Colony. */
  assert.equal(out.pwr_cm1_kwh,     '61701.25');
  assert.equal(out.pwr_packing_kwh, '4653.66');
  assert.equal(out.pwr_lighting_kwh, '3300.41');
  assert.equal(out.pwr_colony_kwh,  '1732.70');
});

test('power-cons: rejects a workbook with no recognised section', () => {
  const msg = 'Could not find any recognised section ("Lime Stone Crusher", "Rawmill Section", "Packing Section"…). Is this a Power Consumption report?';
  for (const f of [FIX.cppApr, FIX.dispatchApr, FIX.prodApr, FIX.stoppageApr]) {
    assert.equal(EX['power-cons'](workbook(f))._error, msg);
  }
});

/* ══════════════════════════════════════════════════════════════════════
   5. Production
   ══════════════════════════════════════════════════════════════════════ */
test('production: April 2026 workbook', () => {
  const out = EX.production(workbook(FIX.prodApr));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-04-21');
  assert.equal(out.kiln_run_hrs,     '24.00');
  assert.equal(out.kiln_prod_mt,     '1210.00');
  assert.equal(out.rm1_run_hrs,      '17.00');
  assert.equal(out.rm1_prod_mt,      '1720.00');
  assert.equal(out.coal_kiln,        '204.00');
  assert.equal(out.spc_crusher_kwh,  '1624');   /* SPECIFIC POWER, TOTAL UNIT CONSUMED row */
  assert.equal(out.coal_ncv,         '5436');
});

test('production: reads three reports three months apart', () => {
  /* The sheet's row COUNT and its SPECIFIC POWER column layout both change
     between these, which is the whole reason the extractor is label-driven. */
  for (const f of [FIX.prodApr, FIX.prodJul, FIX.prodAug]) {
    const out = EX.production(workbook(f));
    assert.equal(out._error, undefined, f);
    assert.match(out.date, /^2026-\d{2}-\d{2}$/, f);
    assert.ok(filled(out) > 80, f + ': only ' + filled(out) + ' fields');
  }
  assert.equal(EX.production(workbook(FIX.prodJul)).date, '2026-07-01');
  assert.equal(EX.production(workbook(FIX.prodAug)).date, '2026-08-30');
});

test('production: rejects a workbook with neither of its anchor sections', () => {
  const msg = 'Could not find "RAW MATERIAL CONSUMPTION" or "PLANT OPERATIONS" section. Is this a Production report?';
  for (const f of [FIX.cppApr, FIX.dispatchApr, FIX.materialsApr, FIX.stoppageApr]) {
    assert.equal(EX.production(workbook(f))._error, msg);
  }
});

/* ══════════════════════════════════════════════════════════════════════
   6. CPP / Power Plant
   ══════════════════════════════════════════════════════════════════════ */
test('cpp: April 2026 workbook', () => {
  const out = EX.cpp(workbook(FIX.cppApr));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-04-21');
  assert.equal(out.cpp_gross_gen_kwh,   '139400.00');
  assert.equal(out.cpp_run_hrs,         '24.00');
  assert.equal(out.cpp_feed_water_mt,   '660.00');
  assert.equal(out.cpp_boiler_steam_mt, '644.00');
  assert.equal(out.cpp_coal_cons,       '132.00');
  assert.equal(out.cpp_coal_gcv,        '4179.00');
  /* "Auxiliary Power Consumption" appears twice — kWhr (17157) and then
     "( % )" (12.3077...). Only the kWhr row is an input; the percentage is
     computed by the page. Picking the wrong one would be plausible-looking
     nonsense, so it is pinned here. */
  assert.equal(out.cpp_aux_kwh,         '17157.00');
});

test('cpp: August 2026 workbook', () => {
  const out = EX.cpp(workbook(FIX.cppAug));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-08-30');
  assert.equal(out.cpp_gross_gen_kwh, '155400.00');
  assert.equal(out.cpp_coal_cons,     '118.00');
  assert.equal(out.cpp_coal_gcv,      '4417.00');
});

test('cpp: rejects a workbook with no CPP rows', () => {
  const msg = 'Could not find "Gross Power Generation" or any other CPP row. Is this a Power Plant report?';
  for (const f of [FIX.dispatchApr, FIX.prodApr, FIX.powerApr, FIX.materialsApr]) {
    assert.equal(EX.cpp(workbook(f))._error, msg);
  }
});

/* ══════════════════════════════════════════════════════════════════════
   7. Pile Quality
   ══════════════════════════════════════════════════════════════════════ */
test('pile-quality: May 2026 workbook, latest dated sheet', () => {
  const out = EX['pile-quality'](workbook(FIX.pileMay));
  assert.equal(out._error, undefined);
  /* Today is not a sheet in this workbook, so the last dated one wins —
     "20.05.2026", whose "% Cao" column runs 49.77 ... 49.54 over 18 rows. */
  assert.equal(out.date,     '2026-05-20');
  assert.equal(out.cao_h1,   '49.77');
  assert.equal(out.cao_h2,   '41.74');
  assert.equal(out.cao_h18,  '49.54');
  assert.equal(filled(out),  18);
});

test('pile-quality: rejects a sheet with no "% CaO" column', () => {
  /* Previously this extractor had no guard: it read a fixed column index
     and returned whatever numbers were in it, so a Power Consumption
     report filled all 18 CaO boxes with kWh figures and said nothing. */
  for (const f of [FIX.powerApr, FIX.dispatchApr, FIX.cppApr, FIX.prodApr, FIX.stoppageApr]) {
    const out = EX['pile-quality'](workbook(f));
    assert.match(out._error || '', /^No "% CaO" column found in sheet ".*"\. Is this a Pile Quality report\?$/,
      f + ' produced data instead of an error: ' + JSON.stringify(out).slice(0, 120));
  }
});

/* ══════════════════════════════════════════════════════════════════════
   8. Limestone %
   ══════════════════════════════════════════════════════════════════════ */
test('limestone: falls back to the last populated day column', () => {
  const out = EX.limestone(workbook(FIX.limestone));
  assert.equal(out._error, undefined);
  /* No sheet for the current month, so the last sheet ("MAY 2026") is used,
     and within it the rightmost column carrying data — 20.05.2026, whose
     Mill-1 42.5R mix is 16.5 % limestone / 78.5 % clinker / 5 % gypsum.
     Stored in the sheet as fractions; the extractor multiplies by 100. */
  assert.equal(out.date,        '2026-05-20');
  assert.equal(out.m1_425r_ls,  '16.50');
  assert.equal(out.m1_425r_ck,  '78.50');
  assert.equal(out.m1_425r_gy,  '5.00');
  assert.equal(out.m2_425r_ls,  '16.50');
});

test('limestone: rejects a workbook with no DD.MM.YYYY day columns', () => {
  for (const f of [FIX.cppApr, FIX.dispatchApr, FIX.prodApr]) {
    const out = EX.limestone(workbook(f));
    assert.match(out._error || '', /^Could not find today's date \(\d{2}\.\d{2}\.\d{4}\) or any data column in sheet ".*"\.$/,
      f + ' produced data instead of an error');
  }
});

/* ══════════════════════════════════════════════════════════════════════
   9. Stoppage — the monthly matrix, matched against the governed catalogue
   ══════════════════════════════════════════════════════════════════════ */
test('stoppage: April 2026 workbook against the seeded reason catalogue', () => {
  const reasons = stoppageReasons();
  assert.equal(reasons.length, 417, 'migration 017 should seed 417 reasons');

  const ex  = loadExtractors({ reasons, formDate: '2026-04-21' });
  const out = ex.stoppage(workbook(FIX.stoppageApr));
  assert.equal(out._error, undefined);
  assert.equal(out.date, '2026-04-21');
  assert.equal(filled(out), 417, 'every catalogue row should get a value (0 included)');

  /* Read straight off the workbook's 21.04.2026 column:
       Crusher sheet        "Crusher/ hopper cleaning"          2 h
                            "Crusher discharge chute Jamming"   2 h  (sheet Total 4)
       Cement Mill -1 sheet "Silo full/ No Orders"             24 h  (sheet Total 24)
       Packing plant sheet  "No trucks available to load"    22.90 h  */
  const byLabel = (equipment, cause, label) => {
    const r = reasons.find(x => x.equipment === equipment && x.cause === cause && x.label === label);
    assert.ok(r, 'catalogue has no ' + equipment + '/' + cause + '/' + label);
    return out['stopr_' + r.id];
  };
  assert.equal(byLabel('crusher', 'prod', 'Crusher/ hopper cleaning'), '2.00');
  assert.equal(byLabel('crusher', 'prod', 'Crusher discharge chute Jamming'), '2.00');
  assert.equal(byLabel('cm1', 'other', 'Silo full/ No Orders'), '24.00');
  assert.equal(byLabel('packing', 'other', 'No trucks available to load'), '22.90');

  /* Cross-check against the sheet's own arithmetic: the Crusher tab totals
     4 hours for that day, and these two rows are the only non-zero ones. */
  const crusherHours = reasons
    .filter(r => r.equipment === 'crusher')
    .reduce((s, r) => s + (parseFloat(out['stopr_' + r.id]) || 0), 0);
  assert.equal(crusherHours, 4);
});

test('stoppage: a different month of the same matrix also resolves', () => {
  const reasons = stoppageReasons();
  const ex  = loadExtractors({ reasons, formDate: '2026-04-21' });
  const out = ex.stoppage(workbook(FIX.stoppageAprM));
  assert.equal(out._error, undefined);
  assert.ok(filled(out) > 400, 'expected the full catalogue, got ' + filled(out));
});

test('stoppage: says so when the workbook does not cover the report date', () => {
  const reasons = stoppageReasons();
  const ex  = loadExtractors({ reasons, formDate: '2026-04-21' });
  /* The August matrix has no 21 April column; so does every non-stoppage
     workbook, which is the same failure from the user's point of view. */
  for (const f of [FIX.stoppageAug, FIX.cppApr, FIX.dispatchApr]) {
    assert.equal(ex.stoppage(workbook(f))._error,
      'Could not find 2026-04-21 as a day column in any equipment sheet. ' +
      'Set the report date in the toolbar first, or check this workbook covers that month.');
  }
});

test('stoppage: refuses to guess when the reason catalogue has not loaded', () => {
  const ex = loadExtractors({ formDate: '2026-04-21' });
  assert.equal(ex.stoppage(workbook(FIX.stoppageApr))._error,
    'The stoppage reason list has not loaded on this page yet. ' +
    'Reload the page (so the reason boxes render), then try Import Excel again.');
});

/* ══════════════════════════════════════════════════════════════════════
   10. Cross-extractor agreement
   Three different departments' workbooks for 21.04.2026 describe the same
   day. Where they overlap they must agree — which proves the extractors
   are reading the RIGHT cells, not merely stable ones.
   ══════════════════════════════════════════════════════════════════════ */
test('the April 21 workbooks agree with each other where they overlap', () => {
  const ex  = loadExtractors({ materials: true });
  const mat  = ex.materials(workbook(FIX.materialsApr));
  const prod = EX.production(workbook(FIX.prodApr));
  const cpp  = EX.cpp(workbook(FIX.cppApr));
  const disp = EX.dispatch(workbook(FIX.dispatchApr));

  for (const out of [mat, prod, cpp, disp]) assert.equal(out.date, '2026-04-21');

  /* Iron ore opening stock + on-date consumption: Raw Materials report vs
     the Production report's own RAW MATERIAL CONSUMPTION table. */
  assert.equal(parseFloat(mat.iron_ore_open), parseFloat(prod.rmm_ironore_open));
  assert.equal(parseFloat(mat.iron_ore_cons), parseFloat(prod.rmm_ironore_cons));
  /* CPP coal burnt: the Power Plant report vs the Production report. */
  assert.equal(parseFloat(cpp.cpp_coal_cons), parseFloat(prod.coal_cpp));
});

/* ══════════════════════════════════════════════════════════════════════
   11. Coverage ledger — fails if an extractor is added without a test
   ══════════════════════════════════════════════════════════════════════ */
test('every extractor in the map is covered above', () => {
  const covered = ['dispatch', 'quality', 'materials', 'power-cons', 'pile-quality',
    'limestone', 'production', 'cpp', 'stoppage'];
  assert.deepEqual(Object.keys(EX).sort(), covered.slice().sort(),
    'forms/excel-import.js gained or lost an extractor — add or remove its tests here');
});
