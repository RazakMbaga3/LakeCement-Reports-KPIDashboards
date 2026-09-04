/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — KPI Facts & Formula Registry (single source of truth)
   ─────────────────────────────────────────────────────────────────
   THE one place a KPI is defined. Loaded by BOTH runtimes:
     • backend/services/formulaEngine.js — evaluates against Postgres
       and serves /api/formula/* (this is what dashboards render)
     • analytics.js in the browser — same functions for the offline /
       demo-data fallback, so the math literally cannot diverge

   Design (agreed 2026-07-04, do not restructure casually):
     FACTS    — one entry per raw field; each declares exactly ONE
                source ('manual' now; flip to 'odoo' per-fact when a
                department's Odoo feed goes live — no formula changes).
     FORMULAS — plain reviewed JS functions over fact keys (a string
                expression DSL was considered and rejected: real
                formulas need weighted averages and per-variant field
                subsets). Each carries label/unit/dp/target/signage/
                version. daily(f) gets fact values (number|null) for
                one day; monthlyAgg says how days roll up.
                `notes` is a plain-English statement of the method and
                any caveats — it feeds the generated KPI reference
                (backend: npm run docs:kpi → docs/KPI_REFERENCE.md),
                so keep it current when the formula changes.

   Changing a formula here changes every dashboard that renders it —
   bump `version` and note the change in the commit message.
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* value if it's a positive number, else null */
  function pos(v) { return (v !== null && v !== undefined && !isNaN(v) && v > 0) ? Number(v) : null; }
  /* treat null/NaN as 0 in sums */
  function z0(v)  { var n = Number(v); return isNaN(n) ? 0 : n; }

  /* ── FACTS ─────────────────────────────────────────────────────── */
  var FACTS = {
    // quality form
    free_lime:    { source: 'manual', form: 'quality', field: 'free_lime',    unit: '%' },
    blaine_425r:  { source: 'manual', form: 'quality', field: 'blaine_425r',  unit: 'cm²/g' },
    strength_28d: { source: 'manual', form: 'quality', field: 'strength_28d', unit: 'MPa' },

    // dispatch form — three independently loaded channels (Regular Bags, Bulker,
    // Big Bags), each broken down by grade, matching the source Dispatch Report's
    // own column layout. Big Bags is only packed for 42.5R/42.5N B-M/42.5N.
    dispatch_reg_425r:    { source: 'manual', form: 'dispatch', field: 'dispatch_reg_425r',    unit: 'MT' },
    dispatch_reg_425nbm:  { source: 'manual', form: 'dispatch', field: 'dispatch_reg_425nbm',  unit: 'MT' },
    dispatch_reg_425n:    { source: 'manual', form: 'dispatch', field: 'dispatch_reg_425n',    unit: 'MT' },
    dispatch_reg_325n:    { source: 'manual', form: 'dispatch', field: 'dispatch_reg_325n',    unit: 'MT' },
    dispatch_reg_opc425n: { source: 'manual', form: 'dispatch', field: 'dispatch_reg_opc425n', unit: 'MT' },
    dispatch_blk_425r:    { source: 'manual', form: 'dispatch', field: 'dispatch_blk_425r',    unit: 'MT' },
    dispatch_blk_425nbm:  { source: 'manual', form: 'dispatch', field: 'dispatch_blk_425nbm',  unit: 'MT' },
    dispatch_blk_425n:    { source: 'manual', form: 'dispatch', field: 'dispatch_blk_425n',    unit: 'MT' },
    dispatch_blk_325n:    { source: 'manual', form: 'dispatch', field: 'dispatch_blk_325n',    unit: 'MT' },
    dispatch_blk_opc425n: { source: 'manual', form: 'dispatch', field: 'dispatch_blk_opc425n', unit: 'MT' },
    dispatch_bag_425r:    { source: 'manual', form: 'dispatch', field: 'dispatch_bag_425r',    unit: 'MT' },
    dispatch_bag_425nbm:  { source: 'manual', form: 'dispatch', field: 'dispatch_bag_425nbm',  unit: 'MT' },
    dispatch_bag_425n:    { source: 'manual', form: 'dispatch', field: 'dispatch_bag_425n',    unit: 'MT' },
    dispatch_clinker:     { source: 'manual', form: 'dispatch', field: 'dispatch_clinker',     unit: 'MT' },

    // legacy pre-channel-split dispatch fields — real submissions made
    // before the reg/blk/bag rebuild are stored under these flat names
    // (confirmed on Render: a 2026-07-22 submission with 376.5 MT was
    // going uncounted because 'despatch-day' only read the new facts).
    // Kept only as a fallback in despatch-day's daily() below — never
    // used as a primary source for new data. legacy:true tells
    // backend/test/fact-fields.test.js not to expect these on any
    // current form — they intentionally only exist in old rows.
    dispatch_legacy_425r:    { source: 'manual', form: 'dispatch', field: 'dispatch_425r',    unit: 'MT', legacy: true },
    dispatch_legacy_425nbm:  { source: 'manual', form: 'dispatch', field: 'dispatch_425nbm',  unit: 'MT', legacy: true },
    dispatch_legacy_425n:    { source: 'manual', form: 'dispatch', field: 'dispatch_425n',    unit: 'MT', legacy: true },
    dispatch_legacy_325n:    { source: 'manual', form: 'dispatch', field: 'dispatch_325n',    unit: 'MT', legacy: true },
    dispatch_legacy_opc425n: { source: 'manual', form: 'dispatch', field: 'dispatch_opc425n', unit: 'MT', legacy: true },
    dispatch_legacy_bulker:  { source: 'manual', form: 'dispatch', field: 'dispatch_bulker',  unit: 'MT', legacy: true },
    dispatch_legacy_bigbag:  { source: 'manual', form: 'dispatch', field: 'dispatch_bigbag',  unit: 'MT', legacy: true },

    // kiln fields — captured on the Production Report (Plant Operations).
    // kiln_coal_cons/kiln_coal_ncv previously pointed at form fields that
    // don't exist (kiln_coal_cons/kiln_coal_ncv were never real data-field
    // names anywhere in the app — confirmed 2026-07-24 by grepping every
    // form's HTML). The real fields are 'coal_kiln' on the production
    // report (Fuel — Coal section) and 'ncv' on the limestone form (NCV &
    // Average Clinker Consumption section) — this had silently made
    // Specific Thermal Energy Consumption uncomputable for every real
    // submission, not just backfilled data.
    kiln_prod_mt:   { source: 'manual', form: 'production', field: 'kiln_prod_mt', unit: 'MT' },
    kiln_coal_cons: { source: 'manual', form: 'production', field: 'coal_kiln',    unit: 'MT' },
    kiln_coal_ncv:  { source: 'manual', form: 'limestone',  field: 'ncv',          unit: 'kcal/kg' },

    // power consumption form
    pwr_crusher_kwh:   { source: 'manual', form: 'power-cons', field: 'pwr_crusher_kwh',   unit: 'kWh' },
    pwr_rawmill_kwh:   { source: 'manual', form: 'power-cons', field: 'pwr_rawmill_kwh',   unit: 'kWh' },
    pwr_rawmill2_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_rawmill2_kwh',  unit: 'kWh' },
    pwr_coalmill_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_coalmill_kwh',  unit: 'kWh' },
    pwr_kiln_kwh:      { source: 'manual', form: 'power-cons', field: 'pwr_kiln_kwh',      unit: 'kWh' },
    pwr_cm1_kwh:       { source: 'manual', form: 'power-cons', field: 'pwr_cm1_kwh',       unit: 'kWh' },
    pwr_cm2_kwh:       { source: 'manual', form: 'power-cons', field: 'pwr_cm2_kwh',       unit: 'kWh' },
    pwr_packing_kwh:   { source: 'manual', form: 'power-cons', field: 'pwr_packing_kwh',   unit: 'kWh' },
    pwr_packing2_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_packing2_kwh',  unit: 'kWh' },
    pwr_lighting_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_lighting_kwh',  unit: 'kWh' },
    pwr_colony_kwh:    { source: 'manual', form: 'power-cons', field: 'pwr_colony_kwh',    unit: 'kWh' },
    pwr_kiln_prod_mt:  { source: 'manual', form: 'power-cons', field: 'pwr_kiln_prod_mt',  unit: 'MT' },
    pwr_cm1_prod_mt:   { source: 'manual', form: 'power-cons', field: 'pwr_cm1_prod_mt',   unit: 'MT' },
    pwr_cm2_prod_mt:   { source: 'manual', form: 'power-cons', field: 'pwr_cm2_prod_mt',   unit: 'MT' },

    // power consumption form — source split & allocation (manual until meter/SCADA feed lands)
    pwr_tanesco_kwh:         { source: 'manual', form: 'power-cons', field: 'pwr_tanesco_kwh',         unit: 'kWh' },
    pwr_cpp_kwh:             { source: 'manual', form: 'power-cons', field: 'pwr_cpp_kwh',             unit: 'kWh' },
    pwr_tanesco_clinker_kwh: { source: 'manual', form: 'power-cons', field: 'pwr_tanesco_clinker_kwh', unit: 'kWh' },
    pwr_cpp_clinker_kwh:     { source: 'manual', form: 'power-cons', field: 'pwr_cpp_clinker_kwh',     unit: 'kWh' },
    pwr_tanesco_cement_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_tanesco_cement_kwh',  unit: 'kWh' },
    pwr_cpp_cement_kwh:      { source: 'manual', form: 'power-cons', field: 'pwr_cpp_cement_kwh',      unit: 'kWh' },
    pwr_tanesco_colony_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_tanesco_colony_kwh',  unit: 'kWh' },
    pwr_cpp_colony_kwh:      { source: 'manual', form: 'power-cons', field: 'pwr_cpp_colony_kwh',      unit: 'kWh' },

    // clinker factor inputs (clinker consumed vs total cement produced), split by source
    // since own-produced and purchased clinker sit on different cost bases — captured on
    // the Production Report (Raw Material Consumption / Plant Operations)
    cm_clinker_own_cons:   { source: 'manual', form: 'production', field: 'cm_clinker_own_cons',   unit: 'MT' },
    cm_clinker_purch_cons: { source: 'manual', form: 'production', field: 'cm_clinker_purch_cons', unit: 'MT' },
    cm1_425r_mt:     { source: 'manual', form: 'production', field: 'cm1_425r_mt',     unit: 'MT' },
    cm1_425n_mt:     { source: 'manual', form: 'production', field: 'cm1_425n_mt',     unit: 'MT' },
    cm1_325n_mt:     { source: 'manual', form: 'production', field: 'cm1_325n_mt',     unit: 'MT' },
    cm1_opc_mt:      { source: 'manual', form: 'production', field: 'cm1_opc_mt',      unit: 'MT' },
    cm2_425r_mt:     { source: 'manual', form: 'production', field: 'cm2_425r_mt',     unit: 'MT' },
    cm2_425n_mt:     { source: 'manual', form: 'production', field: 'cm2_425n_mt',     unit: 'MT' },
    cm2_425n_bm_mt:  { source: 'manual', form: 'production', field: 'cm2_425n_bm_mt',  unit: 'MT' },
    cm2_325n_mt:     { source: 'manual', form: 'production', field: 'cm2_325n_mt',     unit: 'MT' },

    // CM-1 stock-ledger "Consumption" column (Plant Operations, Production Report) —
    // cement leaving CM-1's per-grade stock, i.e. what operations calls dispatch for
    // that mill. See despatch-day below: this IS the dispatch figure now, matching
    // the Production Report's own TOTAL — CM-1 row exactly.
    cm1_325n_cons_mt:    { source: 'manual', form: 'production', field: 'cm1_325n_cons_mt',    unit: 'MT' },
    cm1_425r_cons_mt:    { source: 'manual', form: 'production', field: 'cm1_425r_cons_mt',    unit: 'MT' },
    cm1_425n_cons_mt:    { source: 'manual', form: 'production', field: 'cm1_425n_cons_mt',    unit: 'MT' },
    cm1_opc_cons_mt:     { source: 'manual', form: 'production', field: 'cm1_opc_cons_mt',     unit: 'MT' },
    cm1_425n_bm_cons_mt: { source: 'manual', form: 'production', field: 'cm1_425n_bm_cons_mt', unit: 'MT' },

    // CPP (Captive Power Plant) daily generation report — FRM-LCL-PP-06
    // These were `unwired: true` from 2026-08-19 to 2026-09-04: form_type
    // 'cpp' had no real <input data-field> anywhere in the app, because
    // power-plant-report.html rendered all 22 CPP metrics as read-only
    // data-kpi cells, so cpp-heat-rate and cpp-auxiliary-power could only
    // ever compute null and the 91 imported days had no way to be extended
    // by hand. The page's "On Date" column is now 22 real inputs owned by
    // the cpp role (_DAILY_ACCESS.cpp.edit), so these facts are captured
    // the same way every other manual fact is.
    cpp_gross_gen_kwh:    { source: 'manual', form: 'cpp', field: 'cpp_gross_gen_kwh',    unit: 'kWh' },
    cpp_aux_kwh:          { source: 'manual', form: 'cpp', field: 'cpp_aux_kwh',          unit: 'kWh' },
    cpp_coal_cons:        { source: 'manual', form: 'cpp', field: 'cpp_coal_cons',        unit: 'MT' },
    cpp_coal_gcv:         { source: 'manual', form: 'cpp', field: 'cpp_coal_gcv',         unit: 'kcal/kg' },
    cpp_heat_rate_plant:  { source: 'manual', form: 'cpp', field: 'cpp_heat_rate_plant',  unit: 'kcal/kWh' },
  };

  // pile-quality form: 18 CaO hole samples
  for (var h = 1; h <= 18; h++) {
    FACTS['cao_h' + h] = { source: 'manual', form: 'pile-quality', field: 'cao_h' + h, unit: '%' };
  }

  // stoppage form: 7 plant sections × 6 categories (mechanical, electrical &
  // instrumentation, production, planned, power, other) — 42 fields, minutes.
  var STOP_SECTIONS = ['crusher', 'rm', 'cm_coal', 'kiln', 'cm1', 'cm2', 'packing'];
  var STOP_CATEGORIES = ['mech', 'ei', 'prod', 'planned', 'power', 'other'];
  var STOP_FIELDS = [];
  STOP_SECTIONS.forEach(function (sec) {
    STOP_CATEGORIES.forEach(function (cat) {
      var key = 'stop_' + sec + '_' + cat;
      FACTS[key] = { source: 'manual', form: 'stoppage', field: key, unit: 'min' };
      STOP_FIELDS.push(key);
    });
  });
  var STOP_KILN_FIELDS = STOP_CATEGORIES.map(function (cat) { return 'stop_kiln_' + cat; });

  // materials form: daily consumption for the two core raw materials, plus
  // coal-kiln consumption summed across every supplier (ck_* rows) — matches
  // the "Sub Total — Coal Kiln" section of the source Raw Material workbooks.
  FACTS.mat_clinker_cons = { source: 'manual', form: 'materials', field: 'clinker_cons', unit: 'MT' };
  FACTS.mat_gypsum_cons  = { source: 'manual', form: 'materials', field: 'gypsum_cons',  unit: 'MT' };
  var CK_SUPPLIERS = ['tancoal', 'ruvuma', 'market', 'ariim', 'coalash', 'stamico', 'jitegemee',
                      'maxcoal', 'melt', 'ibrico', 'megacj', 'mabenga', 'yongda', 'kindaini',
                      'montreal', 'ludewa', 'mchekane', 'siaas'];
  var CK_COAL_CONS_FIELDS = CK_SUPPLIERS.map(function (s) {
    var key = 'ck_' + s + '_cons';
    FACTS[key] = { source: 'manual', form: 'materials', field: key, unit: 'MT' };
    return key;
  });

  var KWH_ALL       = ['pwr_crusher_kwh', 'pwr_rawmill_kwh', 'pwr_rawmill2_kwh', 'pwr_coalmill_kwh', 'pwr_kiln_kwh',
                       'pwr_cm1_kwh', 'pwr_cm2_kwh', 'pwr_packing_kwh', 'pwr_packing2_kwh',
                       'pwr_lighting_kwh', 'pwr_colony_kwh'];
  var KWH_CLINKER   = ['pwr_crusher_kwh', 'pwr_rawmill_kwh', 'pwr_rawmill2_kwh', 'pwr_coalmill_kwh', 'pwr_kiln_kwh'];
  var KWH_DOWNSTREAM = ['pwr_cm1_kwh', 'pwr_cm2_kwh', 'pwr_packing_kwh', 'pwr_packing2_kwh',
                        'pwr_lighting_kwh'];
  var KWH_GRINDING  = ['pwr_cm1_kwh', 'pwr_cm2_kwh'];
  var CM_GRADES     = ['cm1_425r_mt', 'cm1_425n_mt', 'cm1_325n_mt', 'cm1_opc_mt',
                       'cm2_425r_mt', 'cm2_425n_mt', 'cm2_425n_bm_mt', 'cm2_325n_mt'];
  // no longer feeds despatch-day (see below) — kept because the Dispatch form
  // still collects its own channel×grade report independently of the KPI.
  var DISPATCH      = ['dispatch_reg_425r', 'dispatch_reg_425nbm', 'dispatch_reg_425n', 'dispatch_reg_325n', 'dispatch_reg_opc425n',
                       'dispatch_blk_425r', 'dispatch_blk_425nbm', 'dispatch_blk_425n', 'dispatch_blk_325n', 'dispatch_blk_opc425n',
                       'dispatch_bag_425r', 'dispatch_bag_425nbm', 'dispatch_bag_425n',
                       'dispatch_clinker'];
  var DISPATCH_LEGACY = ['dispatch_legacy_425r', 'dispatch_legacy_425nbm', 'dispatch_legacy_425n', 'dispatch_legacy_325n',
                         'dispatch_legacy_opc425n', 'dispatch_legacy_bulker', 'dispatch_legacy_bigbag', 'dispatch_clinker'];
  // CM-1 stock-ledger consumption = cement dispatched out of CM-1's grades that
  // day (matches the Production Report's TOTAL — CM-1 On Date Consumption cell).
  var CM1_DISPATCH = ['cm1_325n_cons_mt', 'cm1_425r_cons_mt', 'cm1_425n_cons_mt', 'cm1_opc_cons_mt', 'cm1_425n_bm_cons_mt'];
  var CAO_HOLES     = Object.keys(FACTS).filter(function (k) { return k.indexOf('cao_h') === 0; });

  function sumOf(keys, f) { return keys.reduce(function (s, k) { return s + z0(f[k]); }, 0); }
  /* total cement produced by both mills that day (matches source Excel J42+J48) */
  function totalCementProd(f) { return sumOf(CM_GRADES, f); }
  /* total clinker consumed by the cement mills that day, own + purchased combined
     (matches source Excel's I20+I21 — the two ledgers are summed for the clinker factor) */
  function totalClinkerCons(f) { return z0(f.cm_clinker_own_cons) + z0(f.cm_clinker_purch_cons); }

  /* ── FORMULAS ──────────────────────────────────────────────────────
     Keys are the kpiSlug() of the dashboard row label — that's how
     kpi-data.js matches table rows to results. monthlyAgg:
       'avg' | 'sum'                 — over non-null daily values
       { type:'weighted', weight }   — Σ(daily×w)/Σw, w = weight(facts)
  ─────────────────────────────────────────────────────────────────── */
  var FORMULAS = {

    'clinker-free-lime': {
      label: 'Clinker Free Lime', unit: '%', dp: 1, version: 1,
      target: 3.0, signage: '<', targetLabel: 'Spec 3.0%',
      notes: 'Daily free-lime measurement as reported by the quality lab. Lower is better; spec is < 3.0%.',
      inputs: ['free_lime'],
      daily: function (f) { return pos(f.free_lime); },
      monthlyAgg: 'avg',
    },

    'despatch-day': {
      label: 'Despatch / Day', unit: 'MT', dp: 0, version: 4,
      target: null, signage: null, targetLabel: null,
      notes: 'Cement dispatched for the day = CM-1\'s stock-ledger "Consumption" column, summed across its five grades (32.5N, 42.5R, 42.5N, OPC, 42.5N BM) — this is exactly the Production Report\'s Plant Operations table, TOTAL — CM-1 row, On Date Consumption cell (stock ledger: opening + production − consumption(dispatch) = closing, so that column is cement leaving stock, i.e. dispatch). v4 (2026-07-31): previously sourced from the separate Dispatch form\'s channel×grade breakdown (Regular Bags/Bulker/Big Bags), which drifted from what Operations actually reconciles against on the Production Report and was known to read 0 on days the Dispatch form went unfilled even though CM-1\'s ledger had real consumption entered. Re-pointed to the Production Report figure per Operations\' direction so the two numbers can never disagree — the Dispatch form\'s channel×grade data still feeds its own report, just not this KPI.',
      inputs: CM1_DISPATCH,
      daily: function (f) {
        var t = sumOf(CM1_DISPATCH, f);
        return t > 0 ? t : null;
      },
      monthlyAgg: 'avg',
    },

    'kiln-output': {
      label: 'Kiln Output', unit: 'MT', dp: 0, version: 1,
      target: 2000, signage: '>=', targetLabel: 'Target ≥ 2,000 MT/day',
      notes: 'Clinker produced by the kiln that day, as entered on the kiln form.',
      inputs: ['kiln_prod_mt'],
      daily: function (f) { return pos(f.kiln_prod_mt); },
      monthlyAgg: 'avg',
    },

    'specific-thermal-energy-consumption': {
      label: 'Specific Thermal Energy Consumption', unit: 'kcal/kg', dp: 0, version: 3,
      target: 780, signage: '<', targetLabel: 'Target < 780 kcal/kg',
      notes: 'Heat input per kg of clinker: coal consumed (MT) × coal NCV (kcal/kg) ÷ clinker produced (MT) — the MT units cancel, so there is no ×1000 factor (v2 fix, verified against the source Excel where Q54 = NCV × coal%). The monthly figure is the production-weighted mean, identical to Σ(coal×NCV) ÷ Σclinker. v3: the kiln_coal_cons/kiln_coal_ncv FACTS entries pointed at form fields that never existed anywhere in the app (confirmed 2026-07-24) — silently making this KPI uncomputable for every real submission, not just backfilled data. Repointed to the real fields: coal_kiln on the production report, ncv on the limestone form.',
      inputs: ['kiln_prod_mt', 'kiln_coal_cons', 'kiln_coal_ncv'],
      // per-day: coal(MT) × NCV(kcal/kg) / clinker(MT) — MT/MT cancels, no ×1000
      // (verified against source Excel: Q54 = NCV × coal%, no extra scale factor)
      daily: function (f) {
        var prod = pos(f.kiln_prod_mt), coal = pos(f.kiln_coal_cons), ncv = pos(f.kiln_coal_ncv);
        return (prod && coal && ncv) ? (coal * ncv) / prod : null;
      },
      // month: Σ(coal×ncv)/Σprod ≡ production-weighted mean of daily
      monthlyAgg: { type: 'weighted', weight: function (f) { return pos(f.kiln_prod_mt) || 0; } },
    },

    'specific-power-consumption-total': {
      label: 'Specific Power Consumption – Total', unit: 'kWh/MT eq. cement', dp: 2, version: 4,
      target: null, signage: '<', targetLabel: null,
      provisional: true,
      provisionalNote: 'Understates true power — Compressed Air/Utilities kWh is no longer captured (removed 2026-07-24) and isn’t allocated into this figure. See the formula notes below before trusting the trend.',
      notes: 'Mirrors the source Excel’s 3-layer build (M54): upstream-of-clinker kWh (crusher, raw mills, coal mill, kiln) is expressed per ton of clinker, then scaled to a per-ton-cement basis by the clinker factor (total clinker consumed, own + purchased, ÷ total cement produced by both mills); downstream kWh (cement mills, packing, lighting) is divided by cement produced directly and added. v4: Compressed Air/Utilities is no longer a tracked fact (removed from the power-cons form), so it no longer contributes here — this KPI now understates true total power by whatever utilities used to draw.',
      inputs: KWH_CLINKER.concat(KWH_DOWNSTREAM, ['pwr_kiln_prod_mt', 'cm_clinker_own_cons', 'cm_clinker_purch_cons'], CM_GRADES),
      // Matches source Excel's 3-layer build (row 54, M54): upstream-of-clinker
      // kWh (crusher/raw mill/coal mill/kiln) is expressed per ton clinker, then
      // scaled by the clinker factor (clinker consumed ÷ cement produced) to put
      // it on a per-ton-cement basis; downstream kWh (cement mills, packing,
      // lighting) is already per ton cement and added directly.
      daily: function (f) {
        var cementProd = totalCementProd(f);
        if (cementProd <= 0) return null;
        var clinkerFactor = totalClinkerCons(f) / cementProd;
        var kilnProd = pos(f.pwr_kiln_prod_mt);
        var upstreamPerTonClinker = kilnProd ? sumOf(KWH_CLINKER, f) / kilnProd : 0;
        var upstreamPerTonCement = upstreamPerTonClinker * clinkerFactor;
        var downstreamPerTonCement = sumOf(KWH_DOWNSTREAM, f) / cementProd;
        return upstreamPerTonCement + downstreamPerTonCement;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return totalCementProd(f); } },
    },

    'specific-power-consumption-up-to-clinker': {
      label: 'Specific Power Consumption – Up to Clinker', unit: 'kWh/MT clinker', dp: 2, version: 3,
      target: null, signage: '<', targetLabel: null,
      provisional: true,
      provisionalNote: 'Understates true power — Compressed Air/Utilities kWh is no longer captured (removed 2026-07-24) and isn’t allocated into this figure. Also a known simplification vs. the source Excel (crusher/raw-mill/coal-mill throughput isn’t captured by any form). See the formula notes below.',
      notes: 'v3: back to upstream department kWh only (crusher, raw mills, coal mill, kiln) ÷ clinker produced, with no utilities share. v2 had added 60% of Utilities kWh — the plant\'s own real allocation rule, confirmed against the "CUMULATIVE DAILY" sheet of the IMS power workbooks (Apr–Jun 2026 master power reports) — but Compressed Air/Utilities was subsequently removed as a tracked fact (2026-07-24, deleted from the power-cons form), so there is no longer a utilities figure to allocate. This KPI now understates true up-to-clinker power by its 60% share of whatever utilities used to draw. KNOWN SIMPLIFICATION vs the source Excel regardless: the plant\'s report ideally builds this per department (crusher, raw mill, coal mill each ÷ their own throughput, × a material ratio) — crusher/raw-mill/coal-mill output tonnages aren\'t captured by any form.',
      inputs: KWH_CLINKER.concat(['pwr_kiln_prod_mt']),
      daily: function (f) {
        var prod = pos(f.pwr_kiln_prod_mt);
        return prod ? sumOf(KWH_CLINKER, f) / prod : null;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return pos(f.pwr_kiln_prod_mt) || 0; } },
    },

    'specific-power-consumption-cement-grinding': {
      label: 'Specific Power Consumption – Cement Grinding', unit: 'kWh/MT', dp: 2, version: 4,
      target: null, signage: '<', targetLabel: null,
      provisional: true,
      provisionalNote: 'Understates true power — Compressed Air/Utilities kWh is no longer captured (removed 2026-07-24) and isn’t allocated into this figure. See the formula notes below before trusting the trend.',
      notes: 'v4: CM-1 + CM-2 grinding kWh plus both packing plants (kept from v3 — matches the source Excel\'s combined CEMENT bucket, CM1+CM2+PP1+PP2), ÷ combined mill production. The 40% Utilities share added in v3 is removed: Compressed Air/Utilities was deleted as a tracked fact (2026-07-24), so there is no longer a utilities figure to allocate — this KPI now understates true cement-grinding power by its 40% share of whatever utilities used to draw.',
      inputs: KWH_GRINDING.concat(['pwr_packing_kwh', 'pwr_packing2_kwh', 'pwr_cm1_prod_mt', 'pwr_cm2_prod_mt']),
      daily: function (f) {
        var prod = z0(f.pwr_cm1_prod_mt) + z0(f.pwr_cm2_prod_mt);
        if (prod <= 0) return null;
        var kwh = sumOf(KWH_GRINDING, f) + z0(f.pwr_packing_kwh) + z0(f.pwr_packing2_kwh);
        return kwh / prod;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return z0(f.pwr_cm1_prod_mt) + z0(f.pwr_cm2_prod_mt); } },
    },

    'power-distribution-loss-pct': {
      label: 'Power Distribution Loss %', unit: '%', dp: 2, version: 2,
      target: 2.0, signage: '<', targetLabel: 'Keep < 2%',
      provisional: true,
      provisionalNote: 'Overstates true loss — Compressed Air/Utilities kWh is no longer captured (removed 2026-07-24), so that real consumption reads as "loss" instead. Do not judge against the < 2% target without reading the formula notes below.',
      notes: 'Gap between total power supplied (TANESCO import + CPP generation) and the sum of all metered department sections, as a % of the metered total — the plant\'s internal distribution/measurement loss. Formula verified identical to the source IMS workbook\'s "Total losses" / "% of Loss" rows (CUMULATIVE DAILY sheet, Apr–Jun 2026 master power reports) on a spot-checked day, back when Utilities was still a tracked section. v2: Compressed Air/Utilities was removed as a tracked fact (2026-07-24), so its real kWh draw is no longer subtracted out on the "consumed" side — this KPI now overstates true distribution loss by whatever utilities draws, since that untracked consumption reads as "loss" instead. Interpret accordingly (or re-add a utilities fact) before trusting this against the < 2% target. This calculation originated as a live, unsaved preview on the power-cons entry form (kpi-live.js: pwr_total_loss / pwr_loss_pct); this registry entry is the first place it became a tracked, historical, dashboard-visible KPI rather than a number that only ever appeared while someone had the form open.',
      inputs: KWH_ALL.concat(['pwr_tanesco_kwh', 'pwr_cpp_kwh']),
      daily: function (f) {
        var consumed = sumOf(KWH_ALL, f);
        if (consumed <= 0) return null;
        var supplied = z0(f.pwr_tanesco_kwh) + z0(f.pwr_cpp_kwh);
        return ((supplied - consumed) / consumed) * 100;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return sumOf(KWH_ALL, f); } },
    },

    'blaine-425r': {
      label: 'Blaine 425R', unit: 'cm²/g', dp: 0, version: 1,
      target: 3500, signage: '>=', targetLabel: 'Min 3,500',
      notes: 'Daily Blaine fineness of the 42.5R grade as measured by the quality lab.',
      inputs: ['blaine_425r'],
      daily: function (f) { return pos(f.blaine_425r); },
      monthlyAgg: 'avg',
    },

    'strength-28d': {
      label: '28-Day Strength', unit: 'MPa', dp: 1, version: 1,
      target: 42.5, signage: '>=', targetLabel: 'Min 42.5',
      notes: '28-day compressive strength result reported by the quality lab (relates to samples cast 28 days earlier).',
      inputs: ['strength_28d'],
      daily: function (f) { return pos(f.strength_28d); },
      monthlyAgg: 'avg',
    },

    'pile-cao-avg': {
      label: 'Pile CaO Average', unit: '%', dp: 2, version: 1,
      target: 44.0, signage: '>=', targetLabel: 'Target 44%',
      notes: 'Mean CaO% across the pile-quality form’s hole samples (up to 18 holes); holes left blank are excluded from the average rather than counted as zero.',
      inputs: CAO_HOLES,
      daily: function (f) {
        var vals = [];
        CAO_HOLES.forEach(function (k) { var v = pos(f[k]); if (v !== null) vals.push(v); });
        return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
      },
      monthlyAgg: 'avg',
    },

    'total-power-kwh': {
      label: 'Total Power Consumption', unit: 'kWh', dp: 0, version: 3,
      target: null, signage: null, targetLabel: null,
      provisional: true,
      provisionalNote: 'Understates true total — Compressed Air/Utilities is no longer a tracked section (removed 2026-07-24). See the formula notes below.',
      notes: 'Sum of all metered plant sections including colony. v3: Compressed Air/Utilities is no longer a tracked section (removed as a fact, 2026-07-24) — this total now understates true plant power by whatever utilities draws. Daily totals of 500 kWh or below are treated as meters-not-read (no data) rather than a real total. Monthly value is the straight sum of reported days.',
      inputs: KWH_ALL,
      daily: function (f) { var t = sumOf(KWH_ALL, f); return t > 500 ? t : null; },
      monthlyAgg: 'sum',
    },

    'purchased-clinker-share': {
      label: 'Purchased Clinker Share', unit: '%', dp: 1, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Share of total clinker consumed by the cement mills (own + purchased) that came from purchased clinker rather than own kiln production. The two sources sit on different cost bases, so this is the basis for cost/margin-by-clinker-source reporting.',
      inputs: ['cm_clinker_own_cons', 'cm_clinker_purch_cons'],
      daily: function (f) {
        var total = totalClinkerCons(f);
        return total > 0 ? (z0(f.cm_clinker_purch_cons) / total) * 100 : null;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return totalClinkerCons(f); } },
    },

    'total-stoppage-minutes': {
      label: 'Total Stoppage', unit: 'min', dp: 0, version: 1,
      target: null, signage: '<', targetLabel: null,
      notes: 'Sum of all logged downtime minutes across every plant section (Crusher, Raw Mill, Coal Mill, Kiln, CM-1, CM-2, Packing) and category (Mechanical, Electrical & Instrumentation, Production, Planned, Power, Other) for the day, as entered on the Stoppage Report. A day with no stoppage form submitted is null (no data), not zero downtime.',
      inputs: STOP_FIELDS,
      daily: function (f) {
        var any = STOP_FIELDS.some(function (k) { return f[k] !== null && f[k] !== undefined; });
        return any ? sumOf(STOP_FIELDS, f) : null;
      },
      monthlyAgg: 'avg',
    },

    'kiln-stoppage-minutes': {
      label: 'Kiln Stoppage', unit: 'min', dp: 0, version: 1,
      target: null, signage: '<', targetLabel: null,
      notes: 'Downtime minutes logged against the Kiln section specifically (all categories combined) — the single section whose stoppage directly halts clinker production, as opposed to a downstream/upstream section stoppage the kiln can sometimes run through.',
      inputs: STOP_KILN_FIELDS,
      daily: function (f) {
        var any = STOP_KILN_FIELDS.some(function (k) { return f[k] !== null && f[k] !== undefined; });
        return any ? sumOf(STOP_KILN_FIELDS, f) : null;
      },
      monthlyAgg: 'avg',
    },

    'clinker-consumption-day': {
      label: 'Clinker Consumption', unit: 'MT', dp: 0, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Clinker consumed by the cement mills that day, as logged on the Raw Materials Report ledger (opening + received − consumed = closing).',
      inputs: ['mat_clinker_cons'],
      daily: function (f) { return pos(f.mat_clinker_cons); },
      monthlyAgg: 'sum',
    },

    'gypsum-consumption-day': {
      label: 'Gypsum Consumption', unit: 'MT', dp: 1, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Gypsum consumed that day, as logged on the Raw Materials Report ledger.',
      inputs: ['mat_gypsum_cons'],
      daily: function (f) { return pos(f.mat_gypsum_cons); },
      monthlyAgg: 'sum',
    },

    'coal-kiln-consumption-day': {
      label: 'Coal Consumption (Kiln)', unit: 'MT', dp: 1, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Total coal consumed by the kiln that day, summed across every supplier ledger in the Raw Materials Report\'s "Sub Total — Coal Kiln" section (Tancoal, Ruvuma, Market Insight, Ariim, Coal Ash, State Mining Corporation/STAMICO, Jitegemee, Max Coal, MELT, IBRICO, Mega CJ, Mabenga, Yongda, Kindaini, Montreal, Ludewa, Mchekane, SIAAS). Feeds Specific Thermal Energy Consumption alongside kiln output and coal NCV.',
      inputs: CK_COAL_CONS_FIELDS,
      daily: function (f) {
        var any = CK_COAL_CONS_FIELDS.some(function (k) { return f[k] !== null && f[k] !== undefined; });
        return any ? sumOf(CK_COAL_CONS_FIELDS, f) : null;
      },
      monthlyAgg: 'sum',
    },

    'cpp-heat-rate': {
      label: 'CPP Heat Rate', unit: 'kcal/kWh', dp: 0, version: 1,
      target: 3800, signage: '<', targetLabel: 'Target < 3,800 kcal/kWh',
      notes: 'Captive Power Plant heat rate (Plant, 3300 @ MCR basis) as reported daily on FRM-LCL-PP-06 — a lab/DCS-derived figure taken as-is, not re-derived from coal×GCV÷gross_gen (verified against the source workbook: the reported figure differs slightly from that naive formula, similar to Turbine Steam Consumption not equalling Boiler−Bleed — both are independently measured values). Monthly figure is the gross-generation-weighted mean.',
      inputs: ['cpp_heat_rate_plant', 'cpp_gross_gen_kwh'],
      daily: function (f) { return pos(f.cpp_heat_rate_plant); },
      monthlyAgg: { type: 'weighted', weight: function (f) { return pos(f.cpp_gross_gen_kwh) || 0; } },
    },

    'cpp-auxiliary-power': {
      label: 'CPP Auxiliary Power', unit: '%', dp: 2, version: 1,
      target: 10, signage: '<', targetLabel: 'Target < 10.0%',
      notes: 'Captive Power Plant auxiliary (house-load) power consumption as a % of gross generation — verified against FRM-LCL-PP-06 (aux ÷ gross × 100). Monthly figure is Σaux ÷ Σgross (gross-generation-weighted), not a simple average of daily percentages.',
      inputs: ['cpp_aux_kwh', 'cpp_gross_gen_kwh'],
      daily: function (f) {
        var gross = pos(f.cpp_gross_gen_kwh), aux = pos(f.cpp_aux_kwh);
        return (gross && aux !== null) ? aux / gross * 100 : null;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return pos(f.cpp_gross_gen_kwh) || 0; } },
    },
  };

  var api = { FACTS: FACTS, FORMULAS: FORMULAS, REGISTRY_VERSION: 1 };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NyatiFormulas = api;

}(typeof window !== 'undefined' ? window : globalThis));
