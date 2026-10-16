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
  { free_lime: 2.5, blaine_425r: 3400, strength_28d: 42, c3s_ck: 61.01 },
  { free_lime: 2.8, blaine_425r: 3500, strength_28d: 43, c3s_ck: 55.5 },
  { free_lime: 3.1, blaine_425r: 3600, strength_28d: 44, c3s_ck: 48.99 },
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
// cm1_425r_cons_mt is CM-1's stock-ledger "Consumption" column. It fed
// despatch-day under v4; since v5 (2026-10-10) despatch-day reads the Dispatch
// & SO report instead — see DISPATCH below — so this value must NOT move it.
// The cm2_*_run_hrs values are the cement-mill-2-output fixture: they are the
// source Excel's RUNNING HOURS — ON DATE column for the CEMENT MILL -2 rows
// (Production Report, PLANT OPERATIONS table), which is what the plant's own
// TPH cell divides by. Chosen so each day's TPH is exact to the decimal:
//   day 1: 500 MT / 10 hrs = 50.0    day 2: 400 MT / 8 hrs = 50.0
//   day 3: 600 MT / 10 hrs = 60.0
const CEMENT_MILL = [
  { cm_clinker_own_cons: 440, cm_clinker_purch_cons: 200, cm1_425r_mt: 300, cm2_425r_mt: 500, cm1_425r_cons_mt: 2000, cm2_425r_run_hrs: 10 }, // total prod 800, total clinker 640
  { cm_clinker_own_cons: 520, cm_clinker_purch_cons:   0, cm1_425r_mt: 250, cm2_425r_mt: 400, cm1_425r_cons_mt: 1500, cm2_425r_run_hrs:  8 }, // total prod 650, total clinker 520
  { cm_clinker_own_cons: 300, cm_clinker_purch_cons: 340, cm1_425r_mt: 200, cm2_425r_mt: 600, cm1_425r_cons_mt: 2500, cm2_425r_run_hrs: 10 }, // total prod 800, total clinker 640
];
/* despatch-day v5 fixture — the Dispatch & SO report's channel × grade fields
   plus clinker sold, i.e. what dispatch.html's "Cement Dispatched" card sums.
   Spread across all three channels and the clinker line so a formula that
   dropped any one of them would miss its total:
     day 1: 1200 + 500 + 300            = 2000
     day 2:  800 + 400 + 200 + 100      = 1500   (includes clinker)
     day 3: 1000 + 900 + 400 + 200      = 2500
   These deliberately differ from CEMENT_MILL's cm1_425r_cons_mt only in where
   they live; equal totals keep EXPECTED unchanged from v4. */
const DISPATCH = [
  { dispatch_reg_425r: 1200, dispatch_blk_425nbm: 500, dispatch_bag_425r: 300 },
  { dispatch_reg_325n: 800, dispatch_blk_425r: 400, dispatch_reg_opc425n: 200, dispatch_clinker: 100 },
  { dispatch_reg_425r: 1000, dispatch_blk_425r: 900, dispatch_bag_425nbm: 400, dispatch_blk_opc425n: 200 },
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
  ...KILN[i], ...QUALITY[i], ...POWER[i], ...CEMENT_MILL[i], ...DISPATCH[i], ...PILE[i], ...CPP[i],
}));

const EXPECTED = {
  'kiln-output':        (2000 + 2100 + 1900) / 3,
  'clinker-free-lime':  (2.5 + 2.8 + 3.1) / 3,
  'despatch-day':       (2000 + 1500 + 2500) / 3, // Dispatch & SO fixture, see DISPATCH above (v5)
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

/* The all-facts-missing case above is the easy half. The dangerous half is a
   PARTIALLY filled day: facts for one form present, the other form's absent.
   specific-power-consumption-total guarded only cement production (production
   form) while every kWh input comes from power-cons, so a day with production
   filed and no power reading returned a hard 0 — "0 kWh/MT eq. cement", which
   reads as perfect efficiency rather than missing data. Every sibling SPC/STE
   formula returned null on the same facts. 79 real days across Jul-Sep 2026
   were affected (no power-cons row exists after 2026-06-30). */
test('a cross-form partial day does not fabricate a zero', () => {
  /* Production side fully filled: both mills produced, clinker consumed.
     Fact keys (not form field names) — cm1_425r_mt, not cm1_425r_prod_mt.
     Getting these wrong makes cementProd 0, so the formula returns null via
     its FIRST guard and the test passes for the wrong reason. */
  const productionOnly = {
    cm1_425r_mt: 900, cm2_425r_mt: 700,
    cm_clinker_own_cons: 1200, cm_clinker_purch_cons: 0,
    pwr_kiln_prod_mt: 1500,
  };
  /* Proves the fixture reaches the power guard rather than tripping the
     production one — otherwise every assertion below is vacuous. */
  assert.ok(FORMULAS['cement-produced-day'].daily(productionOnly) > 0,
    'fixture must record real cement production, or the power guard is never reached');

  const spcTotal = FORMULAS['specific-power-consumption-total'].daily(productionOnly);
  assert.strictEqual(spcTotal, null,
    'no kWh reading at all must be null, never 0 — a 0 here reads as perfect efficiency');

  /* Siblings on the identical facts, to keep the whole family consistent. */
  assert.strictEqual(FORMULAS['specific-power-consumption-up-to-clinker'].daily(productionOnly), null);
  assert.strictEqual(FORMULAS['specific-power-consumption-cement-grinding'].daily(productionOnly), null);
  assert.strictEqual(FORMULAS['power-distribution-loss-pct'].daily(productionOnly), null);

  /* And the converse: once ONE real kWh reading exists the formula must
     compute again, so the guard can't silently blank a metered day. */
  const withOneReading = Object.assign({}, productionOnly, { pwr_cm1_kwh: 42000 });
  const v = FORMULAS['specific-power-consumption-total'].daily(withOneReading);
  assert.ok(typeof v === 'number' && v > 0,
    'one genuine kWh reading must still produce a value, got ' + JSON.stringify(v));

  /* A genuine measured zero is data, not absence, and must survive. */
  const genuineZero = Object.assign({}, productionOnly, { pwr_cm1_kwh: 0 });
  assert.strictEqual(FORMULAS['specific-power-consumption-total'].daily(genuineZero), 0,
    'an explicitly recorded 0 kWh is a reading and must not be nulled');
});

test('despatch-day v5: reads the Dispatch report, blank when there is none, ledger ignored', () => {
  const d = FORMULAS['despatch-day'].daily;
  // Matches dispatch.html's "Cement Dispatched": every channel × grade, plus clinker.
  assert.equal(d({ dispatch_reg_425r: 1846, dispatch_reg_325n: 119, dispatch_blk_325n: 30,
                   dispatch_blk_425nbm: 89.4, dispatch_reg_425nbm: 152, dispatch_blk_opc425n: 30 }), 2266.4);
  // No Dispatch report that day -> blank, so it is never averaged in as zero.
  assert.equal(d({ kiln_prod_mt: 1800 }), null);
  // A filed report that genuinely loaded nothing is a real 0.
  assert.equal(d({ dispatch_reg_425r: 0 }), 0);
  // The CM-1 stock ledger (v4's source) no longer moves it.
  assert.equal(d({ cm1_425r_cons_mt: 2000, cm1_425n_bm_cons_mt: 500 }), null);
});

test('ls-crusher-output: production ÷ APRON FEEDER hours; month = Σprod ÷ Σapron, never a mean of daily TPH', () => {
  /* Crusher TPH basis decided 2026-10-15: divide by apron-feeder hours, not
     running hours. Fixture = real Odoo Crusher Production Entry days:
       2026-09-26  CRU/2026/00180           3,969.84 t, run 21.4 h, apron 17.45 h
       2026-09-30  CRU/2026/00184 + 00185   3,889.78 t, run 22.77 h, apron 17.00 h
     plus two days that must not count: no apron hours, and a 0. */
  const f = FORMULAS['ls-crusher-output'];
  const DAYS = [
    { ls_crusher_prod_mt: 3969.84, ls_crusher_run_hrs: 21.4,  ls_crusher_apron_hrs: 17.45 },
    { ls_crusher_prod_mt: 3889.78, ls_crusher_run_hrs: 22.77, ls_crusher_apron_hrs: 17 },
    { ls_crusher_prod_mt: 2500,    ls_crusher_run_hrs: 15 },                              // apron not recorded
    { ls_crusher_prod_mt: 2500,    ls_crusher_run_hrs: 15,    ls_crusher_apron_hrs: 0 },   // placeholder 0
  ];

  // The day Odoo's own screen shows: 227.5 t/h. Running hours must NOT be the divisor (185.5).
  assert.ok(close(f.daily(DAYS[0]), 227.5, 0.05), `2026-09-26 should be 227.5, got ${f.daily(DAYS[0])}`);
  assert.ok(!close(f.daily(DAYS[0]), 3969.84 / 21.4, 1), 'running hours are not the TPH basis');

  // Missing or zero apron hours -> null, never 0 and never a division by zero.
  assert.strictEqual(f.daily(DAYS[2]), null);
  assert.strictEqual(f.daily(DAYS[3]), null);
  assert.strictEqual(f.daily({ ls_crusher_apron_hrs: 17 }), null, 'hours with no tonnage are not a rate');
  assert.strictEqual(f.daily({}), null);

  // Month = (3969.84 + 3889.78) / (17.45 + 17) = 228.14 — the hours-weighted
  // figure; the plain mean of the two daily rates would be 228.16, and the
  // two null days must contribute neither tonnage nor hours.
  const expected = (3969.84 + 3889.78) / (17.45 + 17);
  assert.ok(close(monthlyValue('ls-crusher-output', DAYS), expected, 1e-9),
    `monthly ${monthlyValue('ls-crusher-output', DAYS)} != Σprod/Σapron ${expected}`);
  assert.deepEqual(f.inputs.slice().sort(), ['ls_crusher_apron_hrs', 'ls_crusher_prod_mt']);
});
