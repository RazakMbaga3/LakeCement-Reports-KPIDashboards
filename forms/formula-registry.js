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

    // dispatch form
    dispatch_425r:   { source: 'manual', form: 'dispatch', field: 'dispatch_425r',   unit: 'MT' },
    dispatch_425n:   { source: 'manual', form: 'dispatch', field: 'dispatch_425n',   unit: 'MT' },
    dispatch_bulker: { source: 'manual', form: 'dispatch', field: 'dispatch_bulker', unit: 'MT' },
    dispatch_bigbag: { source: 'manual', form: 'dispatch', field: 'dispatch_bigbag', unit: 'MT' },

    // kiln form
    kiln_prod_mt:   { source: 'manual', form: 'kiln', field: 'kiln_prod_mt',   unit: 'MT' },
    kiln_coal_cons: { source: 'manual', form: 'kiln', field: 'kiln_coal_cons', unit: 'MT' },
    kiln_coal_ncv:  { source: 'manual', form: 'kiln', field: 'kiln_coal_ncv',  unit: 'kcal/kg' },

    // power consumption form
    pwr_crusher_kwh:   { source: 'manual', form: 'power-cons', field: 'pwr_crusher_kwh',   unit: 'kWh' },
    pwr_rawmill_kwh:   { source: 'manual', form: 'power-cons', field: 'pwr_rawmill_kwh',   unit: 'kWh' },
    pwr_coalmill_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_coalmill_kwh',  unit: 'kWh' },
    pwr_kiln_kwh:      { source: 'manual', form: 'power-cons', field: 'pwr_kiln_kwh',      unit: 'kWh' },
    pwr_cm1_kwh:       { source: 'manual', form: 'power-cons', field: 'pwr_cm1_kwh',       unit: 'kWh' },
    pwr_cm2_kwh:       { source: 'manual', form: 'power-cons', field: 'pwr_cm2_kwh',       unit: 'kWh' },
    pwr_packing_kwh:   { source: 'manual', form: 'power-cons', field: 'pwr_packing_kwh',   unit: 'kWh' },
    pwr_packing2_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_packing2_kwh',  unit: 'kWh' },
    pwr_utils_kwh:     { source: 'manual', form: 'power-cons', field: 'pwr_utils_kwh',     unit: 'kWh' },
    pwr_lighting_kwh:  { source: 'manual', form: 'power-cons', field: 'pwr_lighting_kwh',  unit: 'kWh' },
    pwr_kiln_prod_mt:  { source: 'manual', form: 'power-cons', field: 'pwr_kiln_prod_mt',  unit: 'MT' },
    pwr_cm1_prod_mt:   { source: 'manual', form: 'power-cons', field: 'pwr_cm1_prod_mt',   unit: 'MT' },
    pwr_cm2_prod_mt:   { source: 'manual', form: 'power-cons', field: 'pwr_cm2_prod_mt',   unit: 'MT' },

    // cement-mill form — clinker factor inputs (clinker consumed vs total cement produced)
    cm_clinker_cons: { source: 'manual', form: 'cement-mill', field: 'cm_clinker_cons', unit: 'MT' },
    cm1_425r_mt:     { source: 'manual', form: 'cement-mill', field: 'cm1_425r_mt',     unit: 'MT' },
    cm1_425n_mt:     { source: 'manual', form: 'cement-mill', field: 'cm1_425n_mt',     unit: 'MT' },
    cm1_325n_mt:     { source: 'manual', form: 'cement-mill', field: 'cm1_325n_mt',     unit: 'MT' },
    cm1_opc_mt:      { source: 'manual', form: 'cement-mill', field: 'cm1_opc_mt',      unit: 'MT' },
    cm2_425r_mt:     { source: 'manual', form: 'cement-mill', field: 'cm2_425r_mt',     unit: 'MT' },
    cm2_425n_mt:     { source: 'manual', form: 'cement-mill', field: 'cm2_425n_mt',     unit: 'MT' },
    cm2_425n_bm_mt:  { source: 'manual', form: 'cement-mill', field: 'cm2_425n_bm_mt',  unit: 'MT' },
    cm2_325n_mt:     { source: 'manual', form: 'cement-mill', field: 'cm2_325n_mt',     unit: 'MT' },
  };

  // pile-quality form: 18 CaO hole samples
  for (var h = 1; h <= 18; h++) {
    FACTS['cao_h' + h] = { source: 'manual', form: 'pile-quality', field: 'cao_h' + h, unit: '%' };
  }

  var KWH_ALL       = ['pwr_crusher_kwh', 'pwr_rawmill_kwh', 'pwr_coalmill_kwh', 'pwr_kiln_kwh',
                       'pwr_cm1_kwh', 'pwr_cm2_kwh', 'pwr_packing_kwh', 'pwr_packing2_kwh',
                       'pwr_utils_kwh', 'pwr_lighting_kwh'];
  var KWH_CLINKER   = ['pwr_crusher_kwh', 'pwr_rawmill_kwh', 'pwr_coalmill_kwh', 'pwr_kiln_kwh'];
  var KWH_DOWNSTREAM = ['pwr_cm1_kwh', 'pwr_cm2_kwh', 'pwr_packing_kwh', 'pwr_packing2_kwh',
                        'pwr_utils_kwh', 'pwr_lighting_kwh'];
  var KWH_GRINDING  = ['pwr_cm1_kwh', 'pwr_cm2_kwh'];
  var CM_GRADES     = ['cm1_425r_mt', 'cm1_425n_mt', 'cm1_325n_mt', 'cm1_opc_mt',
                       'cm2_425r_mt', 'cm2_425n_mt', 'cm2_425n_bm_mt', 'cm2_325n_mt'];
  var DISPATCH      = ['dispatch_425r', 'dispatch_425n', 'dispatch_bulker', 'dispatch_bigbag'];
  var CAO_HOLES     = Object.keys(FACTS).filter(function (k) { return k.indexOf('cao_h') === 0; });

  function sumOf(keys, f) { return keys.reduce(function (s, k) { return s + z0(f[k]); }, 0); }
  /* total cement produced by both mills that day (matches source Excel J42+J48) */
  function totalCementProd(f) { return sumOf(CM_GRADES, f); }

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
      inputs: ['free_lime'],
      daily: function (f) { return pos(f.free_lime); },
      monthlyAgg: 'avg',
    },

    'despatch-day': {
      label: 'Despatch / Day', unit: 'MT', dp: 0, version: 1,
      target: null, signage: null, targetLabel: null,
      inputs: DISPATCH,
      daily: function (f) { var t = sumOf(DISPATCH, f); return t > 0 ? t : null; },
      monthlyAgg: 'avg',
    },

    'kiln-output': {
      label: 'Kiln Output', unit: 'MT', dp: 0, version: 1,
      target: 2000, signage: '>=', targetLabel: 'Target ≥ 2,000 MT/day',
      inputs: ['kiln_prod_mt'],
      daily: function (f) { return pos(f.kiln_prod_mt); },
      monthlyAgg: 'avg',
    },

    'specific-thermal-energy-consumption': {
      label: 'Specific Thermal Energy Consumption', unit: 'kcal/kg', dp: 0, version: 2,
      target: 780, signage: '<', targetLabel: 'Target < 780 kcal/kg',
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
      label: 'Specific Power Consumption – Total', unit: 'kWh/MT eq. cement', dp: 2, version: 2,
      target: null, signage: '<', targetLabel: null,
      inputs: KWH_CLINKER.concat(KWH_DOWNSTREAM, ['pwr_kiln_prod_mt', 'cm_clinker_cons'], CM_GRADES),
      // Matches source Excel's 3-layer build (row 54, M54): upstream-of-clinker
      // kWh (crusher/raw mill/coal mill/kiln) is expressed per ton clinker, then
      // scaled by the clinker factor (clinker consumed ÷ cement produced) to put
      // it on a per-ton-cement basis; downstream kWh (cement mills, packing,
      // utilities, lighting) is already per ton cement and added directly.
      daily: function (f) {
        var cementProd = totalCementProd(f);
        if (cementProd <= 0) return null;
        var clinkerFactor = z0(f.cm_clinker_cons) / cementProd;
        var kilnProd = pos(f.pwr_kiln_prod_mt);
        var upstreamPerTonClinker = kilnProd ? sumOf(KWH_CLINKER, f) / kilnProd : 0;
        var upstreamPerTonCement = upstreamPerTonClinker * clinkerFactor;
        var downstreamPerTonCement = sumOf(KWH_DOWNSTREAM, f) / cementProd;
        return upstreamPerTonCement + downstreamPerTonCement;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return totalCementProd(f); } },
    },

    'specific-power-consumption-up-to-clinker': {
      label: 'Specific Power Consumption – Up to Clinker', unit: 'kWh/MT clinker', dp: 2, version: 1,
      target: null, signage: '<', targetLabel: null,
      inputs: KWH_CLINKER.concat(['pwr_kiln_prod_mt']),
      // Simplification vs source Excel: the plant's report builds this per
      // department (crusher/raw mill/coal mill each ÷ their OWN throughput,
      // then × a material ratio — e.g. a fixed 1.55 raw-meal-to-clinker
      // factor) because crusher/raw-mill/coal-mill output tonnages aren't
      // captured anywhere in this app yet. Until those fields exist, this
      // divides the same upstream kWh total directly by clinker produced.
      daily: function (f) {
        var prod = pos(f.pwr_kiln_prod_mt);
        return prod ? sumOf(KWH_CLINKER, f) / prod : null;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return pos(f.pwr_kiln_prod_mt) || 0; } },
    },

    'specific-power-consumption-cement-grinding': {
      label: 'Specific Power Consumption – Cement Grinding', unit: 'kWh/MT', dp: 2, version: 2,
      target: null, signage: '<', targetLabel: null,
      inputs: KWH_GRINDING.concat(['pwr_cm1_prod_mt', 'pwr_cm2_prod_mt']),
      // v2: was CM-2 only — CM-1's kWh/production inputs existed on the form
      // but weren't wired to a data-field, so CM-1 power silently never
      // counted. Now sums both mills, matching source Excel's combined
      // "Cem Mill" meter reading.
      daily: function (f) {
        var prod = z0(f.pwr_cm1_prod_mt) + z0(f.pwr_cm2_prod_mt);
        return prod > 0 ? sumOf(KWH_GRINDING, f) / prod : null;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return z0(f.pwr_cm1_prod_mt) + z0(f.pwr_cm2_prod_mt); } },
    },

    'blaine-425r': {
      label: 'Blaine 425R', unit: 'cm²/g', dp: 0, version: 1,
      target: 3500, signage: '>=', targetLabel: 'Min 3,500',
      inputs: ['blaine_425r'],
      daily: function (f) { return pos(f.blaine_425r); },
      monthlyAgg: 'avg',
    },

    'strength-28d': {
      label: '28-Day Strength', unit: 'MPa', dp: 1, version: 1,
      target: 42.5, signage: '>=', targetLabel: 'Min 42.5',
      inputs: ['strength_28d'],
      daily: function (f) { return pos(f.strength_28d); },
      monthlyAgg: 'avg',
    },

    'pile-cao-avg': {
      label: 'Pile CaO Average', unit: '%', dp: 2, version: 1,
      target: 44.0, signage: '>=', targetLabel: 'Target 44%',
      inputs: CAO_HOLES,
      daily: function (f) {
        var vals = [];
        CAO_HOLES.forEach(function (k) { var v = pos(f[k]); if (v !== null) vals.push(v); });
        return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
      },
      monthlyAgg: 'avg',
    },

    'total-power-kwh': {
      label: 'Total Power Consumption', unit: 'kWh', dp: 0, version: 2,
      target: null, signage: null, targetLabel: null,
      inputs: KWH_ALL,
      daily: function (f) { var t = sumOf(KWH_ALL, f); return t > 500 ? t : null; },
      monthlyAgg: 'sum',
    },
  };

  var api = { FACTS: FACTS, FORMULAS: FORMULAS, REGISTRY_VERSION: 1 };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NyatiFormulas = api;

}(typeof window !== 'undefined' ? window : globalThis));
