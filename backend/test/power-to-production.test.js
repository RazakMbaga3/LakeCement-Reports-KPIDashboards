/*
  test/power-to-production.test.js — the pure half of
  services/powerToProduction.js: which Production Report fields are filled
  from the Power Consumption report, from which readings, and when the copy
  must refuse (no zeros, no estimates, never over a person's number).
  No database — that part is scripts/accept-power-to-production.js.

  Section 4 is anchored to the plant's own files, not to numbers written
  here: it runs the browser's real Excel importer (forms/excel-import.js,
  evaluated in a vm exactly as test/excel-extractors.test.js does) over the
  two days the repo holds BOTH a daily Power Consumption report and that
  day's Production Report, and checks the copy against the Production
  Report's own TOTAL UNIT CONSUMED row.

  Usage: node --test test/power-to-production.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const vm     = require('vm');
const path   = require('path');

const {
  MAPPING, MAPPED_FIELDS, NOT_MAPPED, EQUAL_TOLERANCE_KWH,
  derivePowerFields, reconcileDay,
} = require('../services/powerToProduction');

const REPO = path.join(__dirname, '..', '..');

/* The 30.08.2026 daily Power Consumption report as the form imports it. */
const AUG30 = {
  pwr_crusher_kwh: '1690.93', pwr_rawmill_kwh: '36344.11', pwr_rawmill2_kwh: '5710.10',
  pwr_coalmill_kwh: '12646.68', pwr_kiln_kwh: '56804.26', pwr_cm1_kwh: '64396.23',
  pwr_cm2_kwh: '31505.93', pwr_packing_kwh: '7190.17', pwr_lighting_kwh: '3542.53',
  pwr_colony_kwh: '1951.95',
};

/* ══ 1. The mapping itself ═════════════════════════════════════════════ */
test('maps exactly the seven verified Production fields', () => {
  assert.deepEqual([...MAPPED_FIELDS].sort(), [
    'spc_cemmill_kwh', 'spc_coalmill_kwh', 'spc_crusher_kwh', 'spc_kiln_kwh',
    'spc_others_kwh', 'spc_pplant_kwh', 'spc_rm1_kwh',
  ]);
});

test('RAW MILL-2 and LOSSES are never written, and say why', () => {
  for (const f of ['spc_rm2_kwh', 'spc_losses_kwh']) {
    assert.ok(!MAPPED_FIELDS.includes(f), f + ' must not be mapped');
    assert.ok(NOT_MAPPED[f], f + ' needs a recorded reason');
  }
  const out = derivePowerFields({ ...AUG30, pwr_tanesco_kwh: '86414', pwr_cpp_kwh: '137288' });
  assert.equal('spc_rm2_kwh' in out.values, false);
  assert.equal('spc_losses_kwh' in out.values, false);
});

test('every source field is a real input on forms/power-form.html (or the documented legacy name)', () => {
  const html = fs.readFileSync(path.join(REPO, 'forms', 'power-form.html'), 'utf8');
  const legacy = new Set(['pwr_utils_kwh']);   // Apr–Jun IMS import's name for the UTILITIES meter
  for (const m of MAPPING) {
    for (const names of [...m.required, ...(m.optional || [])]) {
      for (const name of names) {
        if (legacy.has(name)) continue;
        assert.match(html, new RegExp(`data-field="${name}"`), `${name} (for ${m.field}) is not an input on the form`);
      }
    }
  }
});

/* ══ 2. derivePowerFields ══════════════════════════════════════════════ */
test('derive: the plant\'s own sums (RM-1+RM-2, CM-1+CM-2, utilities+colony)', () => {
  const { values, skipped } = derivePowerFields(AUG30);
  assert.deepEqual(skipped, []);
  assert.equal(values.spc_crusher_kwh, 1690.93);
  assert.equal(values.spc_rm1_kwh, 42054.21);
  assert.equal(values.spc_kiln_kwh, 56804.26);
  assert.equal(values.spc_coalmill_kwh, 12646.68);
  assert.equal(values.spc_cemmill_kwh, 95902.16);
  assert.equal(values.spc_pplant_kwh, 7190.17);
  assert.equal(values.spc_others_kwh, 5494.48);
});

test('derive: optional second line may be blank (Excel import puts the whole section in the first box)', () => {
  const { values } = derivePowerFields({ ...AUG30, pwr_rawmill2_kwh: '', pwr_packing2_kwh: undefined });
  assert.equal(values.spc_rm1_kwh, 36344.11);
  assert.equal(values.spc_pplant_kwh, 7190.17);
  const both = derivePowerFields({ ...AUG30, pwr_packing_kwh: '2520.65', pwr_packing2_kwh: '2835.48' });
  assert.equal(both.values.spc_pplant_kwh, 5356.13);
});

test('derive: a missing required reading skips the field — never a partial sum, never a zero', () => {
  const { values, skipped } = derivePowerFields({ ...AUG30, pwr_cm1_kwh: '', pwr_colony_kwh: null, pwr_crusher_kwh: undefined });
  assert.equal('spc_cemmill_kwh' in values, false, 'CM-2 alone is not CEM MILL');
  assert.equal('spc_others_kwh' in values, false, 'utilities alone is not OTHERS');
  assert.equal('spc_crusher_kwh' in values, false);
  assert.deepEqual(skipped.map(s => s.field).sort(), ['spc_cemmill_kwh', 'spc_crusher_kwh', 'spc_others_kwh']);
});

test('derive: zero or negative totals are not readings', () => {
  const { values, skipped } = derivePowerFields({ ...AUG30, pwr_crusher_kwh: '0', pwr_kiln_kwh: -5 });
  assert.equal('spc_crusher_kwh' in values, false);
  assert.equal('spc_kiln_kwh' in values, false);
  assert.equal(skipped.length, 2);
});

test('derive: UTILITIES under its legacy Apr–Jun name, and refusal when the two names disagree', () => {
  /* 2026-04-21: IMS stored 2,982.94 as pwr_utils_kwh; the daily report's
     "Plant Lighting, Welding DB & CCR" line is the same 2,982.94. */
  const legacy = { ...AUG30, pwr_lighting_kwh: undefined, pwr_utils_kwh: 2982.94, pwr_colony_kwh: 2360.54 };
  assert.equal(derivePowerFields(legacy).values.spc_others_kwh, 5343.48);
  const same = { ...legacy, pwr_lighting_kwh: '2982.94' };
  assert.equal(derivePowerFields(same).values.spc_others_kwh, 5343.48, 'both names, same reading: counted once');
  const clash = { ...legacy, pwr_lighting_kwh: '3100' };
  const out = derivePowerFields(clash);
  assert.equal('spc_others_kwh' in out.values, false);
  assert.match(out.skipped.find(s => s.field === 'spc_others_kwh').reason, /disagree/);
});

test('derive: no report -> nothing at all', () => {
  const { values, skipped } = derivePowerFields(null);
  assert.deepEqual(values, {});
  assert.equal(skipped.length, MAPPED_FIELDS.length);
});

/* ══ 3. reconcileDay — the no-overwrite / no-zero rules ════════════════ */
const POWER = derivePowerFields(AUG30).values;

test('reconcile: fills blank, missing and form-default-0 fields; never touches unmapped ones', () => {
  const prod = { spc_crusher_kwh: '0', spc_rm1_kwh: '', spc_rm2_kwh: '0', spc_losses_kwh: '0', kiln_prod_mt: 2010 };
  const plan = reconcileDay(prod, POWER, {});
  assert.equal(plan.set.spc_crusher_kwh, 1690.93);
  assert.equal(plan.set.spc_rm1_kwh, 42054.21);
  assert.equal(plan.set.spc_kiln_kwh, 56804.26, 'absent key is filled');
  assert.equal('spc_rm2_kwh' in plan.set, false);
  assert.equal('spc_losses_kwh' in plan.set, false);
  assert.equal('kiln_prod_mt' in plan.set, false);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(Object.keys(plan.copied).length, 7);
});

test('reconcile: a person\'s different figure is kept and reported as a conflict', () => {
  const plan = reconcileDay({ spc_kiln_kwh: '57096', spc_rm1_kwh: 41762 }, POWER, {});
  assert.equal('spc_kiln_kwh' in plan.set, false);
  assert.equal('spc_rm1_kwh' in plan.set, false);
  assert.deepEqual(plan.conflicts.map(c => c.field).sort(), ['spc_kiln_kwh', 'spc_rm1_kwh']);
  const k = plan.conflicts.find(c => c.field === 'spc_kiln_kwh');
  assert.equal(k.production_value, 57096);
  assert.equal(k.power_value, 56804.26);
});

test(`reconcile: within ${EQUAL_TOLERANCE_KWH} kWh is equal — the plant's whole-kWh rounding is not a conflict`, () => {
  const plan = reconcileDay({ spc_crusher_kwh: 1691, spc_others_kwh: '5495', spc_cemmill_kwh: 95902 }, POWER, {});
  for (const f of ['spc_crusher_kwh', 'spc_others_kwh', 'spc_cemmill_kwh']) {
    assert.equal(plan.outcome[f], 'equal', f);
    assert.equal(f in plan.set, false, f);
  }
  assert.equal('spc_crusher_kwh' in plan.copied, false, 'an equal human value is not claimed as ours');
});

test('reconcile: a correction on the power report updates a value the copy wrote', () => {
  const plan = reconcileDay({ spc_crusher_kwh: 1650 }, POWER, { spc_crusher_kwh: '1650.00' });
  assert.equal(plan.set.spc_crusher_kwh, 1690.93);
  assert.equal(plan.outcome.spc_crusher_kwh, 'updated');
});

test('reconcile: once a person changes a copied value, it is theirs', () => {
  const plan = reconcileDay({ spc_crusher_kwh: 1800 }, POWER, { spc_crusher_kwh: 1650 });
  assert.equal('spc_crusher_kwh' in plan.set, false);
  assert.equal(plan.outcome.spc_crusher_kwh, 'conflict');
  assert.equal('spc_crusher_kwh' in plan.copied, false);
});

test('reconcile: power gone -> remove only what the copy wrote; never write 0', () => {
  const prod = { spc_crusher_kwh: 1690.93, spc_kiln_kwh: 57096, spc_rm1_kwh: '0' };
  const plan = reconcileDay(prod, {}, { spc_crusher_kwh: 1690.93, spc_kiln_kwh: 56804.26 });
  assert.deepEqual(plan.remove, ['spc_crusher_kwh']);
  assert.deepEqual(plan.set, {});
  assert.equal(plan.outcome.spc_kiln_kwh, 'none', "a person's value survives the source going away");
  assert.deepEqual(plan.copied, {});
});

test('reconcile: nothing to do on a day already in step', () => {
  const prod = Object.fromEntries(Object.entries(POWER));
  const owned = Object.fromEntries(Object.entries(POWER));
  const plan = reconcileDay(prod, POWER, owned);
  assert.deepEqual(plan.set, {});
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.copied, owned);
});

/* ══ 4. Against the plant's own files ══════════════════════════════════ */
function loadExtractors() {
  const XLSX = require(path.join(REPO, 'vendor', 'xlsx-0.18.5', 'xlsx.full.min.js'));
  const el = () => ({
    value: '', style: {}, dataset: {}, className: '', id: '', innerHTML: '',
    appendChild() {}, insertBefore() {}, addEventListener() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    dispatchEvent() { return true; }, setAttribute() {}, getAttribute() { return null; },
  });
  const document = {
    readyState: 'complete', currentScript: { src: 'http://localhost/forms/excel-import.js' },
    head: el(), body: el(), createElement: el, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, dispatchEvent() { return true; },
  };
  const sandbox = { XLSX, document, console, URL, setTimeout,
    localStorage: { getItem: () => null, setItem() {} }, alert() {}, Event: class {}, CustomEvent: class {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'forms', 'excel-import.js'), 'utf8'), sandbox);
  const read = (rel) => XLSX.read(new Uint8Array(fs.readFileSync(path.join(REPO, rel))), { type: 'array' });
  return { EX: sandbox.window._nyatiExtractors, read };
}

function pairedDay(powerFile, productionFile) {
  const { EX, read } = loadExtractors();
  const power = EX['power-cons'](read(powerFile));
  const production = EX.production(read(productionFile));
  assert.equal(power._error, undefined);
  assert.equal(production._error, undefined);
  assert.equal(power.date, production.date, 'the two workbooks must be the same day');
  return { derived: derivePowerFields(power).values, production };
}

test('21.04.2026: the copy reproduces all 7 fields of the Production Report\'s TOTAL UNIT CONSUMED row', () => {
  const { derived, production } = pairedDay(
    '8. Power consumption report 21.04.2026 (2).xlsx',
    '1. Production Report 21.04.2026 (1).xlsx');
  for (const f of MAPPED_FIELDS) {
    assert.ok(Math.abs(derived[f] - Number(production[f])) <= EQUAL_TOLERANCE_KWH,
      `${f}: power ${derived[f]} vs production ${production[f]}`);
  }
});

test('30.08.2026: 5 of 7 equal; RAW MILL-1 and KILN differ by the same 292 kWh in opposite directions', () => {
  /* The production officer moved 292 kWh from raw mill to kiln that day;
     the two together still agree. Kept as a test so the next person sees
     the measured state of the source, not an assumption. */
  const { derived, production } = pairedDay(
    'FW_ MIS REPORT 30.08.2026/8. Power consumption report 30.08.2026.xlsx',
    'FW_ MIS REPORT 30.08.2026/1. Production Report 30.08.2026.xlsx');
  const equal = MAPPED_FIELDS.filter(f => Math.abs(derived[f] - Number(production[f])) <= EQUAL_TOLERANCE_KWH);
  assert.deepEqual(equal.sort(),
    ['spc_cemmill_kwh', 'spc_coalmill_kwh', 'spc_crusher_kwh', 'spc_others_kwh', 'spc_pplant_kwh']);
  const rmPlusKiln = derived.spc_rm1_kwh + derived.spc_kiln_kwh;
  assert.ok(Math.abs(rmPlusKiln - (Number(production.spc_rm1_kwh) + Number(production.spc_kiln_kwh))) <= EQUAL_TOLERANCE_KWH);
  /* And the copy would NOT overwrite the officer's figures for those two. */
  const plan = reconcileDay(production, derived, {});
  assert.deepEqual(plan.conflicts.map(c => c.field).sort(), ['spc_kiln_kwh', 'spc_rm1_kwh']);
  assert.deepEqual(Object.keys(plan.set), []);
});

/* ══ 5. One source per KPI, and the hooks ══════════════════════════════ */
test('the KPI registry never reads spc_* — the specific-power KPIs read the power-cons facts directly', () => {
  const { FACTS, FORMULAS } = require('../../forms/formula-registry.js');
  for (const [key, fact] of Object.entries(FACTS)) {
    assert.ok(!/^spc_/.test(fact.field), `fact ${key} reads ${fact.field}: the copy would become a second source`);
  }
  for (const k of ['specific-power-consumption-total', 'specific-power-consumption-up-to-clinker',
                   'specific-power-consumption-cement-grinding', 'power-distribution-loss-pct']) {
    const kwhInputs = FORMULAS[k].inputs.filter(i => /_kwh$/.test(i));
    assert.ok(kwhInputs.length, k);
    for (const i of kwhInputs) assert.equal(FACTS[i].form, 'power-cons', `${k} input ${i}`);
  }
});

test('routes/reports.js runs the copy after a save and after approve/reject — never in the autosave branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
  const calls = src.match(/await syncAfterReportWrite\(formType, date, shift\)/g) || [];
  assert.equal(calls.length, 3, 'submit, approve, reject');
  const autosaveBlock = src.slice(src.indexOf('if (autosave) {'), src.indexOf('const isDraft'));
  assert.ok(autosaveBlock.length > 0 && !/syncAfterReportWrite/.test(autosaveBlock));
  const submitTx = src.indexOf('const outcome = await db.withTransaction');
  assert.ok(src.indexOf('await syncAfterReportWrite', submitTx) > src.indexOf('if (outcome.locked)', submitTx),
    'the copy runs after the save has committed and passed the lock check');
});
