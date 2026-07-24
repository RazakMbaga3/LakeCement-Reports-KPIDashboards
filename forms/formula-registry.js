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

    // kiln fields — captured on the Production Report (Plant Operations)
    kiln_prod_mt:   { source: 'manual', form: 'production', field: 'kiln_prod_mt',   unit: 'MT' },
    kiln_coal_cons: { source: 'manual', form: 'production', field: 'kiln_coal_cons', unit: 'MT' },
    kiln_coal_ncv:  { source: 'manual', form: 'production', field: 'kiln_coal_ncv',  unit: 'kcal/kg' },

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
  };

  // pile-quality form: 18 CaO hole samples
  for (var h = 1; h <= 18; h++) {
    FACTS['cao_h' + h] = { source: 'manual', form: 'pile-quality', field: 'cao_h' + h, unit: '%' };
  }

  var KWH_ALL       = ['pwr_crusher_kwh', 'pwr_rawmill_kwh', 'pwr_rawmill2_kwh', 'pwr_coalmill_kwh', 'pwr_kiln_kwh',
                       'pwr_cm1_kwh', 'pwr_cm2_kwh', 'pwr_packing_kwh', 'pwr_packing2_kwh',
                       'pwr_lighting_kwh', 'pwr_colony_kwh'];
  var KWH_CLINKER   = ['pwr_crusher_kwh', 'pwr_rawmill_kwh', 'pwr_rawmill2_kwh', 'pwr_coalmill_kwh', 'pwr_kiln_kwh'];
  var KWH_DOWNSTREAM = ['pwr_cm1_kwh', 'pwr_cm2_kwh', 'pwr_packing_kwh', 'pwr_packing2_kwh',
                        'pwr_lighting_kwh'];
  var KWH_GRINDING  = ['pwr_cm1_kwh', 'pwr_cm2_kwh'];
  var CM_GRADES     = ['cm1_425r_mt', 'cm1_425n_mt', 'cm1_325n_mt', 'cm1_opc_mt',
                       'cm2_425r_mt', 'cm2_425n_mt', 'cm2_425n_bm_mt', 'cm2_325n_mt'];
  var DISPATCH      = ['dispatch_reg_425r', 'dispatch_reg_425nbm', 'dispatch_reg_425n', 'dispatch_reg_325n', 'dispatch_reg_opc425n',
                       'dispatch_blk_425r', 'dispatch_blk_425nbm', 'dispatch_blk_425n', 'dispatch_blk_325n', 'dispatch_blk_opc425n',
                       'dispatch_bag_425r', 'dispatch_bag_425nbm', 'dispatch_bag_425n',
                       'dispatch_clinker'];
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
      label: 'Despatch / Day', unit: 'MT', dp: 0, version: 2,
      target: null, signage: null, targetLabel: null,
      notes: 'Total cement + clinker dispatched for the day, summed across every loading channel (Regular Bags, Bulker, Big Bags — three independently loaded streams, matching the source Dispatch Report) and grade (42.5R, 42.5N BM, 42.5N, 32.5N, OPC 42.5N; Big Bags only packed for 42.5R/42.5N B-M/42.5N) plus clinker. v2: previously Bulker/Big Bags were single un-graded totals, so a grade’s dispatch across all channels could not be reconstructed — now every channel×grade cell is its own fact. A zero total is treated as no data, not a zero-dispatch day.',
      inputs: DISPATCH,
      daily: function (f) { var t = sumOf(DISPATCH, f); return t > 0 ? t : null; },
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
      label: 'Specific Thermal Energy Consumption', unit: 'kcal/kg', dp: 0, version: 2,
      target: 780, signage: '<', targetLabel: 'Target < 780 kcal/kg',
      notes: 'Heat input per kg of clinker: coal consumed (MT) × coal NCV (kcal/kg) ÷ clinker produced (MT) — the MT units cancel, so there is no ×1000 factor (v2 fix, verified against the source Excel where Q54 = NCV × coal%). The monthly figure is the production-weighted mean, identical to Σ(coal×NCV) ÷ Σclinker.',
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
  };

  var api = { FACTS: FACTS, FORMULAS: FORMULAS, REGISTRY_VERSION: 1 };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NyatiFormulas = api;

}(typeof window !== 'undefined' ? window : globalThis));
