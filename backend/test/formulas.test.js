/*
  test/formulas.test.js — pure unit tests for forms/formula-registry.js.

  No server, no Postgres — calls the registry's daily()/monthlyAgg functions
  directly and checks them against independently hand-coded arithmetic. This
  is the fast, run-on-every-save companion to accept-phase3.js (which proves
  the same math end-to-end through the live API + DB). Fixtures below are
  the same numbers accept-phase3.js already hand-verified.

  Guards specifically against the two bug classes that have hit this file:
    - a formula's arithmetic drifting from the audited source Excel
      (e.g. the STE x1000 unit error, the SPC clinker-factor rebuild)
    - a field that exists on a form but isn't wired into the registry's
      input lists, so it's silently excluded from every KPI that uses it
      (e.g. pwr_cm1_kwh / pwr_packing2_kwh before the fix)

  Usage: node --test test/formulas.test.js   (from backend/)
*/

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const { FORMULAS } = require(path.join('..', '..', 'forms', 'formula-registry.js'));

/* Mirrors backend/services/formulaEngine.js's aggregate() exactly, so this
   test proves what the engine will actually compute, not a reinvented rule. */
function monthlyValue(key, dailyFacts) {
  const formula = FORMULAS[key];
  const rows = dailyFacts.map(f => ({ value: formula.daily(f), facts: f }));
  const valid = rows.filter(r => r.value !== null && r.value !== undefined && !Number.isNaN(r.value));
  if (!valid.length) return null;

  const agg = formula.monthlyAgg || 'avg';
  if (agg === 'sum') return valid.reduce((s, r) => s + r.value, 0);
  if (agg === 'avg') return valid.reduce((s, r) => s + r.value, 0) / valid.length;
  if (agg.type === 'weighted') {
    let wSum = 0, vSum = 0;
    for (const r of valid) {
      const w = agg.weight(r.facts) || 0;
      if (w > 0) { wSum += w; vSum += r.value * w; }
    }
    return wSum > 0 ? vSum / wSum : null;
  }
  return null;
}

const close = (a, b, eps = 0.01) => a !== null && b !== null && Math.abs(a - b) <= eps;

/* ── Fixtures — identical to backend/scripts/accept-phase3.js ────────── */
const KILN = [
  { kiln_prod_mt: 2000, kiln_coal_cons: 250, kiln_coal_ncv: 4800 },
  { kiln_prod_mt: 2100, kiln_coal_cons: 260, kiln_coal_ncv: 4900 },
  { kiln_prod_mt: 1900, kiln_coal_cons: 240, kiln_coal_ncv: 4700 },
];
const QUALITY = [
  { free_lime: 2.5, blaine_425r: 3400, strength_28d: 42 },
  { free_lime: 2.8, blaine_425r: 3500, strength_28d: 43 },
  { free_lime: 3.1, blaine_425r: 3600, strength_28d: 44 },
];
// old flat totals renamed 1:1 onto the new channel×grade facts (reg/blk/bag),
// keeping each day's grand total identical to the pre-split fixtures
const DISPATCH = [
  { dispatch_reg_425r: 1000, dispatch_reg_425n: 200, dispatch_blk_425r: 300, dispatch_bag_425r: 500 },
  { dispatch_reg_425r:  700, dispatch_reg_425n: 300, dispatch_blk_425r: 200, dispatch_bag_425r: 300 },
  { dispatch_reg_425r: 1200, dispatch_reg_425n: 400, dispatch_blk_425r: 400, dispatch_bag_425r: 500 },
];
// pwr_utils_kwh removed 2026-07-24 (Compressed Air/Utilities deleted from
// the power-cons form) — consumed/supplied comments below reflect that.
const POWER = [
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 10000, pwr_coalmill_kwh: 5000, pwr_kiln_kwh: 15000,
    pwr_cm1_kwh: 6000, pwr_cm2_kwh: 8000, pwr_packing_kwh: 3000, pwr_packing2_kwh: 500,
    pwr_lighting_kwh: 2000,
    pwr_tanesco_kwh: 30000, pwr_cpp_kwh: 27200, // supplied 57200 vs consumed 54500 -> +2700 loss
    pwr_kiln_prod_mt: 1500, pwr_cm1_prod_mt: 300, pwr_cm2_prod_mt: 500 }, // clinker subset 35000
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 11000, pwr_coalmill_kwh: 5000, pwr_kiln_kwh: 16000,
    pwr_cm1_kwh: 6000, pwr_cm2_kwh: 8000, pwr_packing_kwh: 1000, pwr_packing2_kwh: 0,
    pwr_lighting_kwh: 1000,
    pwr_tanesco_kwh: 28000, pwr_cpp_kwh: 26500, // supplied 54500 vs consumed 53000 -> +1500 loss
    pwr_kiln_prod_mt: 1600, pwr_cm1_prod_mt: 250, pwr_cm2_prod_mt: 400 }, // clinker subset 37000
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 9000, pwr_coalmill_kwh: 4000, pwr_kiln_kwh: 15000,
    pwr_cm1_kwh: 5000, pwr_cm2_kwh: 7000, pwr_packing_kwh: 1000, pwr_packing2_kwh: 0,
    pwr_lighting_kwh: 500,
    pwr_tanesco_kwh: 24000, pwr_cpp_kwh: 23200, // supplied 47200 vs consumed 46500 -> +700 loss
    pwr_kiln_prod_mt: 1400, pwr_cm1_prod_mt: 200, pwr_cm2_prod_mt: 600 }, // clinker subset 33000
];
// clinker consumed = 80% of total cement produced each day (clean clinker factor),
// split own/purchased to also exercise totalClinkerCons() summing both facts
const CEMENT_MILL = [
  { cm_clinker_own_cons: 440, cm_clinker_purch_cons: 200, cm1_425r_mt: 300, cm2_425r_mt: 500 }, // total prod 800, total clinker 640
  { cm_clinker_own_cons: 520, cm_clinker_purch_cons:   0, cm1_425r_mt: 250, cm2_425r_mt: 400 }, // total prod 650, total clinker 520
  { cm_clinker_own_cons: 300, cm_clinker_purch_cons: 340, cm1_425r_mt: 200, cm2_425r_mt: 600 }, // total prod 800, total clinker 640
];
const PILE = [
  { cao_h1: 44, cao_h2: 46 }, // daily avg 45
  { cao_h1: 43 },             // daily avg 43
  {},                          // no samples -> null day
];
// CPP (Captive Power Plant) daily generation report fixtures
const CPP = [
  { cpp_gross_gen_kwh: 29100, cpp_aux_kwh: 6960, cpp_heat_rate_plant: 4655.08 },
  { cpp_gross_gen_kwh: 103100, cpp_aux_kwh: 16407, cpp_heat_rate_plant: 4535.88 },
  { cpp_gross_gen_kwh: 181500, cpp_aux_kwh: 17898, cpp_heat_rate_plant: 3817.33 },
];

const DAYS = [0, 1, 2].map(i => ({
  ...KILN[i], ...QUALITY[i], ...DISPATCH[i], ...POWER[i], ...CEMENT_MILL[i], ...PILE[i], ...CPP[i],
}));

const EXPECTED = {
  'kiln-output':        (2000 + 2100 + 1900) / 3,
  'clinker-free-lime':  (2.5 + 2.8 + 3.1) / 3,
  'despatch-day':       (2000 + 1500 + 2500) / 3,
  'blaine-425r':        (3400 + 3500 + 3600) / 3,
  'strength-28d':       (42 + 43 + 44) / 3,
  'pile-cao-avg':       (45 + 43) / 2,
  // v3: no longer includes utilities (removed 2026-07-24) -> 54500+53000+46500
  'total-power-kwh':    54500 + 53000 + 46500,
  'specific-thermal-energy-consumption':
    (250 * 4800 + 260 * 4900 + 240 * 4700) / (2000 + 2100 + 1900),
  // v3: back to upstream kWh only, no utilities share (utilities fact removed 2026-07-24)
  'specific-power-consumption-up-to-clinker':
    (35000 + 37000 + 33000) / (1500 + 1600 + 1400),
  // v4: CM1+CM2 + both packing plants, no utilities share (utilities fact removed 2026-07-24)
  'specific-power-consumption-cement-grinding':
    (((6000 + 8000) + (3000 + 500)) +
     ((6000 + 8000) + (1000 + 0))   +
     ((5000 + 7000) + (1000 + 0))) / (800 + 650 + 800),
  // v4: downstream sums no longer include utilities (was 21500/17000/14000 with utils)
  'specific-power-consumption-total':
    ((35000 / 1500 * 640) + (37000 / 1600 * 520) + (33000 / 1400 * 640) +
     (19500 + 16000 + 13500)) / (800 + 650 + 800),
  // v2: supplied (tanesco+cpp) minus consumed (KWH_ALL, no utilities) as % of consumed
  'power-distribution-loss-pct': (2700 + 1500 + 700) * 100 / (54500 + 53000 + 46500),
  // purchased ÷ (own+purchased) clinker consumed, weighted by total clinker consumed
  'purchased-clinker-share': (200 + 0 + 340) / (640 + 520 + 640) * 100,                 // 30
  // gross-generation-weighted mean heat rate / aux%
  'cpp-heat-rate': (4655.08 * 29100 + 4535.88 * 103100 + 3817.33 * 181500) / (29100 + 103100 + 181500),
  'cpp-auxiliary-power': (6960 + 16407 + 17898) / (29100 + 103100 + 181500) * 100,
};

test('every registered formula matches independently hand-coded monthly arithmetic', () => {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    assert.ok(FORMULAS[key], `formula "${key}" missing from registry`);
    const got = monthlyValue(key, DAYS);
    assert.ok(close(got, expected),
      `${key}: expected ≈ ${expected}, got ${got}`);
  }
});

/* ── Regression: Specific Thermal Energy x1000 unit bug ──────────────── */
test('specific-thermal-energy-consumption does not reintroduce the x1000 unit bug', () => {
  const day = { kiln_prod_mt: 2000, kiln_coal_cons: 250, kiln_coal_ncv: 4800 };
  const v = FORMULAS['specific-thermal-energy-consumption'].daily(day);
  // Correct: (coal x NCV) / clinker = (250 x 4800) / 2000 = 600 kcal/kg.
  // The old bug scaled this by 1000 -> 600,000, which is off the chart for
  // a KPI whose target is 780 kcal/kg.
  assert.ok(close(v, 600), `expected 600 kcal/kg, got ${v}`);
  assert.ok(v < 780 * 10, 'value is an order of magnitude too high — x1000 bug may be back');
});

/* ── Regression: CM-1 / Packing-2 power silently excluded ─────────────
   Both fields existed on the power form before the fix but had no entry
   in formula-registry.js, so every SPC KPI silently ignored them. Assert
   the formulas are actually sensitive to these inputs, not just present. */
test('specific-power-consumption formulas are sensitive to pwr_cm1_kwh and pwr_packing2_kwh', () => {
  const base = { ...POWER[0], ...CEMENT_MILL[0] };
  const withoutCm1AndPacking2 = { ...base, pwr_cm1_kwh: 0, pwr_cm1_prod_mt: 0, pwr_packing2_kwh: 0 };

  const totalWith = FORMULAS['specific-power-consumption-total'].daily(base);
  const totalWithout = FORMULAS['specific-power-consumption-total'].daily(withoutCm1AndPacking2);
  assert.notStrictEqual(totalWith, totalWithout,
    'SPC-total is unaffected by pwr_cm1_kwh/pwr_packing2_kwh — wiring gap may have regressed');

  const grindingWith = FORMULAS['specific-power-consumption-cement-grinding'].daily(base);
  const grindingWithout = FORMULAS['specific-power-consumption-cement-grinding'].daily(withoutCm1AndPacking2);
  assert.notStrictEqual(grindingWith, grindingWithout,
    'SPC-cement-grinding is unaffected by pwr_cm1_kwh — CM-1 wiring gap may have regressed');
});

/* ── Formulas return null (not 0, not NaN) when required inputs are absent ── */
test('formulas return null instead of 0/NaN when required facts are missing', () => {
  assert.strictEqual(FORMULAS['kiln-output'].daily({}), null);
  assert.strictEqual(FORMULAS['specific-thermal-energy-consumption'].daily({ kiln_prod_mt: 2000 }), null);
  assert.strictEqual(FORMULAS['specific-power-consumption-total'].daily({}), null);
  assert.strictEqual(FORMULAS['specific-power-consumption-up-to-clinker'].daily({}), null);
  assert.strictEqual(FORMULAS['specific-power-consumption-cement-grinding'].daily({}), null);
  assert.strictEqual(FORMULAS['power-distribution-loss-pct'].daily({}), null);
  assert.strictEqual(FORMULAS['pile-cao-avg'].daily({}), null);
});
