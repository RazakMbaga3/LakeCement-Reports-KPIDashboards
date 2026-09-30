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
    /* free_lime is the CLINKER free lime (F.CaO), the day average of the
       QC workbook's six four-hourly clinker readings. It sat in the
       quality form's finished-cement block until 2026-09-22, where the
       workbook has no such column — the importer was filling that cement
       row from the clinker average all along. Same measurement, correct
       section now; no change to the fact or to any filed row.

       blaine_425r is in m²/kg — the unit the QC workbook and the TBS
       requirement it prints ("380 to 410") are both written in. It was
       declared as cm²/g here until 2026-09-22 while the only figure ever
       filed under it came from a mockup, not a lab sheet. */
    free_lime:    { source: 'manual', form: 'quality', field: 'free_lime',    unit: '%' },
    blaine_425r:  { source: 'manual', form: 'quality', field: 'blaine_425r',  unit: 'm²/kg' },
    strength_28d: { source: 'manual', form: 'quality', field: 'strength_28d', unit: 'MPa' },

    /* c3s_ck — Bogue C₃S of the CLINKER, day average. Declared 2026-09-24.
       The field has existed on the quality form since the 2026-09-22 rebuild
       (forms/quality-form.html, "Bogue phase composition — day average"
       block, with the workbook's own ">50%" hint printed in the cell) and
       real submissions carry it, but it was never a fact — so index.html's
       "Clinker C3S" row and the Executive Summary card of the same name had
       to stand on a hardcoded illustrative figure. Same provenance as
       free_lime directly above: it is the mean of the QC workbook's six
       four-hourly CLINKER readings (DAILY SUMMARY sheet, "CLINKER : 4 HRS
       AVG" block, column R), which the lab computes and the form captures as
       one number per day. Verified 2026-09-24 against "6. Quality Report
       21.04.2026 (2).xlsx": R46:R51 = 61.7722 / 69.9040 / 72.4963 / 59.3599
       / 54.4992 / 48.0106, mean 61.007, and the stored 2026-04-21 row reads
       c3s_ck = 61.01. */
    c3s_ck:       { source: 'manual', form: 'quality', field: 'c3s_ck',       unit: '%' },

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

    // packing lines + open sales orders — also entered on the Dispatch & SO
    // form, but until 2026-09-15 they were not facts at all. The Dispatch
    // form computed Bags Packed, Burst Bag Rate and SO Pendency in its own
    // initKpiLive() block with targets typed inline (7000, 0.30) and RAG
    // bands typed inline (350/250 MT), so those three numbers existed only
    // for as long as the page was open: no stored history, nothing for the
    // KPI Tracker or the MIS pack to read, no override/audit trail, and a
    // target that nothing could check against a source of truth because
    // there wasn't one. Declared here so they are ordinary KPIs like the
    // other twenty. The fields themselves are unchanged — this reads the
    // same data-field names the form has always submitted.
    /* The "_pl1"/"_pl2" suffixes are a misnomer inherited from the source
       report and kept because renaming would orphan every stored row:
       _pl1 is the 42.5 R figure, _pl2 the 42.5 N / B-M figure. Both are
       entered in the SAME Packing Line 1 column on the form; per-line
       output has never been captured anywhere. */
    bags_pl1:       { source: 'manual', form: 'dispatch', field: 'bags_pl1',       unit: 'bags' },  // 42.5 R
    bags_pl2:       { source: 'manual', form: 'dispatch', field: 'bags_pl2',       unit: 'bags' },  // 42.5 N / B-M
    burst_rate_pl1: { source: 'manual', form: 'dispatch', field: 'burst_rate_pl1', unit: '%' },     // 42.5 R
    burst_rate_pl2: { source: 'manual', form: 'dispatch', field: 'burst_rate_pl2', unit: '%' },     // 42.5 N / B-M

    so_425r:    { source: 'manual', form: 'dispatch', field: 'so_425r',    unit: 'MT' },
    so_425nbm:  { source: 'manual', form: 'dispatch', field: 'so_425nbm',  unit: 'MT' },
    so_425n:    { source: 'manual', form: 'dispatch', field: 'so_425n',    unit: 'MT' },
    so_325n:    { source: 'manual', form: 'dispatch', field: 'so_325n',    unit: 'MT' },
    so_opc425n: { source: 'manual', form: 'dispatch', field: 'so_opc425n', unit: 'MT' },
    so_bulker:  { source: 'manual', form: 'dispatch', field: 'so_bulker',  unit: 'MT' },
    so_bigbag:  { source: 'manual', form: 'dispatch', field: 'so_bigbag',  unit: 'MT' },
    so_clinker: { source: 'manual', form: 'dispatch', field: 'so_clinker', unit: 'MT' },

    // The month's dispatch plan, entered once on the Dispatch & SO form's
    // Target row. A fact rather than an anonymous input so that "what was
    // the plan that month" is answerable later — it is the denominator of
    // every MTD-achievement figure the dispatch pages show.
    dispatch_mtd_target: { source: 'manual', form: 'dispatch', field: 'dispatch_mtd_target', unit: 'MT' },

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

    /* CM-2's fifth grade and its per-grade Running Hours column — declared
       2026-09-24 so cement-mill-2-output (TPH) can be computed from the same
       report that already supplies the tonnages. All six have been real
       <input data-field> cells on daily-report.html's Plant Operations table
       since it was built; they are the Excel's own columns F (RUNNING HOURS
       — ON DATE) and J (PRODUCTION — ON DATE) for rows 40–44, whose TOTAL —
       CM-2 row 45 carries the TPH the plant reports (Q45 = J45 ÷ F45).

       cm2_opc_mt is deliberately NOT added to CM_GRADES below: doing so
       would silently change cement-produced-day and the clinker factor
       inside specific-power-consumption-total, which is a separate change
       needing its own source trace and version bump. See the data-gap note
       on cement-mill-2-output for what that omission currently costs. */
    cm2_opc_mt:          { source: 'manual', form: 'production', field: 'cm2_opc_mt',          unit: 'MT' },
    cm2_325n_run_hrs:    { source: 'manual', form: 'production', field: 'cm2_325n_run_hrs',    unit: 'Hrs' },
    cm2_425r_run_hrs:    { source: 'manual', form: 'production', field: 'cm2_425r_run_hrs',    unit: 'Hrs' },
    cm2_425n_run_hrs:    { source: 'manual', form: 'production', field: 'cm2_425n_run_hrs',    unit: 'Hrs' },
    cm2_opc_run_hrs:     { source: 'manual', form: 'production', field: 'cm2_opc_run_hrs',     unit: 'Hrs' },
    cm2_425n_bm_run_hrs: { source: 'manual', form: 'production', field: 'cm2_425n_bm_run_hrs', unit: 'Hrs' },

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
    // Running Hours — added 2026-09-16 alongside the Power Plant review page
    // (power-plant.html), to promote Plant Load Factor into the registry.
    // Was already a real <input data-field="cpp_run_hrs"> on
    // power-plant-report.html (Section 1, "Plant Running Hours") and already
    // fed that page's own PLF tile/table row — just not a declared fact until
    // cpp-plant-load-factor below needed it for provenance tracking.
    cpp_run_hrs:          { source: 'manual', form: 'cpp', field: 'cpp_run_hrs',          unit: 'Hrs' },
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
  /* CM-2 alone, all FIVE grades including OPC — the source Excel's rows 40–44,
     whose TOTAL — CM-2 row (45) is what the plant reports CM-2 output from.
     Note this is a superset of CM_GRADES' CM-2 half, which omits cm2_opc_mt
     (see that fact's declaration above). Used only by the two cement-mill-2-*
     formulas, so no existing KPI's value moves. */
  var CM2_GRADES    = ['cm2_325n_mt', 'cm2_425r_mt', 'cm2_425n_mt', 'cm2_opc_mt', 'cm2_425n_bm_mt'];
  var CM2_RUN_HRS   = ['cm2_325n_run_hrs', 'cm2_425r_run_hrs', 'cm2_425n_run_hrs',
                       'cm2_opc_run_hrs', 'cm2_425n_bm_run_hrs'];
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
  /* Open sales orders, all channels and grades — the Dispatch & SO form's
     SO Pendency row, which is one figure per grade rather than a total. */
  var SO_PENDENCY = ['so_425r', 'so_425nbm', 'so_425n', 'so_325n', 'so_opc425n', 'so_bulker', 'so_bigbag', 'so_clinker'];
  var CAO_HOLES     = Object.keys(FACTS).filter(function (k) { return k.indexOf('cao_h') === 0; });

  function sumOf(keys, f) { return keys.reduce(function (s, k) { return s + z0(f[k]); }, 0); }
  /* True when at least one of `keys` carries a real reading.

     sumOf() deliberately reads a missing field as 0 so that one unmetered
     section doesn't null out a whole total. The cost is that "every input is
     missing" and "every input is genuinely zero" produce the same 0, which is
     only safe for a formula whose guard already proves the reading exists.
     Any formula dividing by, or built on, a sumOf() total needs this instead
     — see specific-power-consumption-total, where it was the difference
     between "no power data" and a headline 0 kWh/MT. */
  function anyReading(keys, f) {
    for (var i = 0; i < keys.length; i++) {
      var v = f[keys[i]];
      if (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) return true;
    }
    return false;
  }
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

    /* Added 2026-09-24. index.html carried a "Clinker C3S" row in the
       Production table and a Clinker C3S card in the Executive Summary's
       "Awaiting a data source" panel, both on a hardcoded illustrative 51%,
       on the strength of a comment saying no registry KPI covered it. The
       field has been submitted by the quality form since 2026-09-22; only
       the fact and formula were missing. */
    'clinker-c3s': {
      label: 'Clinker C3S', unit: '%', dp: 1, version: 1,
      target: 50, signage: '>=', targetLabel: 'Target > 50%',
      notes: 'Tricalcium silicate (3CaO·SiO₂, "alite") as a percentage of the clinker, by Bogue calculation — the phase that carries almost all of a Portland cement\'s early strength, so it is the single number the kiln is steered by: too low and 3-day and 7-day strengths fall short of the TBS grade, too high and it is being bought with extra fuel and a harder-burning, more refractory-hostile kiln. The value stored is the DAY AVERAGE EXACTLY AS THE LAB REPORTS IT — the mean of the six four-hourly clinker samples in the QC Daily Report\'s "CLINKER : 4 HRS AVG" block (DAILY SUMMARY sheet, column R) — and is NOT re-derived here from CaO/SiO₂/Al₂O₃/Fe₂O₃. That is deliberate: the lab applies its own Bogue variant and free-lime correction, and recomputing it from the oxide columns would produce a second, slightly different C₃S that disagrees with the certificate the lab actually issues. Verified 2026-09-24 against "6. Quality Report 21.04.2026 (2).xlsx": the six readings R46:R51 average 61.007 and the stored 2026-04-21 row reads 61.01. The > 50% floor is the QC workbook\'s own printed target, the same ">50%" hint the entry form prints in the cell (forms/quality-form.html) and the same figure index.html\'s Production KPI table carries; it is a floor, not a band — a high C₃S is a fuel-cost question, not a conformance failure, so signage is ">=" like Blaine. Monthly figure is the mean of the days that reported. CAVEAT ON COVERAGE: as of 2026-09-24 the database holds exactly ONE reported quality day (2026-04-21), so this KPI is source-verified but not trend-verified — see the Quality entry gap in docs/pm/RAID_LOG.md.',
      inputs: ['c3s_ck'],
      daily: function (f) { return pos(f.c3s_ck); },
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

    /* Added 2026-09-15, alongside the Production review page (production.html).
       Cement produced that day by both mills combined — matches the source
       Excel's J42+J48 total (see totalCementProd() above, already used by
       specific-power-consumption-total's clinker-factor arithmetic; this
       formula only exposes that same sum as its own KPI). No target is
       declared: unlike Kiln Output, which the plant states a firm 2,000
       MT/day figure for, cement-mill throughput is not compared against any
       single daily number in the source Excel or a KPI Tracker sheet — none
       is invented here. monthlyAgg is 'avg' rather than 'sum', matching Kiln
       Output's and Despatch/Day's own convention: this is a MT/day rate, and
       the monthly figure is the mean of the days that reported, not a period
       total (a period total is answerable separately, by summing the daily
       series over the range, same as any other 'avg'-aggregated KPI). */
    'cement-produced-day': {
      label: 'Cement Produced (CM-1 + CM-2)', unit: 'MT', dp: 0, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Cement produced that day by both cement mills combined, summed across every grade on the Production Report — CM-1 (32.5N, 42.5R, 42.5N, OPC, 42.5N BM) and CM-2 (32.5N, 42.5R, 42.5N, 42.5N BM) — matching the source Excel\'s J42+J48 total exactly, and the same CM_GRADES sum specific-power-consumption-total already uses for its clinker-factor arithmetic. No target is declared anywhere in the plant\'s reporting for total cement-mill throughput, so none is invented here (contrast Kiln Output, which does have a stated 2,000 MT/day target). Monthly figure is the mean of the days that reported — a rate, matching Kiln Output\'s and Despatch/Day\'s own convention — not a period total.',
      inputs: CM_GRADES,
      daily: function (f) { return pos(totalCementProd(f)); },
      monthlyAgg: 'avg',
    },

    /* ── Cement Mill 2 ────────────────────────────────────────────────
       Added 2026-09-24. index.html has carried a "Cement Mill 2 Output |
       TPH | >= | 55" row in the Production table and a card of the same
       name in the Executive Summary's "Awaiting a data source" panel, on a
       hardcoded illustrative 62 TPH, next to a comment claiming no registry
       KPI could cover it. Two keys, because the two questions have
       genuinely different data behind them: OUTPUT is the throughput rate
       the plant sets a target on and can only be computed on days that
       report running hours; PRODUCTION is the plain daily tonnage, which is
       reported on essentially every day. ────────────────────────────── */

    'cement-mill-2-output': {
      label: 'Cement Mill 2 Output', unit: 'TPH', dp: 1, version: 1,
      target: 55, signage: '>=', targetLabel: 'Target ≥ 55 TPH',
      provisional: true,
      provisionalNote: 'Two data gaps, both outside this formula. (1) Running hours are only captured on manually-filed Production Reports — the Odoo autofill does not carry them — so this KPI is null, not zero, for every day since 2026-06-30. A blank month means "hours not reported", not "the mill did not run"; Cement Mill 2 Production (MT/day) still has those days. (2) On Apr–Jun days when CM-2 ran OPC, the stored rows hold the OPC running hours but zero OPC tonnage, which understates the rate. See the formula notes below before judging this against the 55 TPH target.',
      notes: 'Cement Mill 2 throughput = total CM-2 production that day ÷ total CM-2 running hours that day, both summed across all five grades (32.5N, 42.5R, 42.5N, OPC, 42.5N BM). This is the source Excel\'s own TPH cell, not a reconstruction: Production Report, PLANT OPERATIONS table, CEMENT MILL -2 TOTAL row, Q = J ÷ F. Verified 2026-09-24 against "1. Production Report 21.04.2026 (1).xlsx": F45 = 19.1 hrs, J45 = 995 MT, Q45 = 52.094, and the same arithmetic over the stored 2026-04-21 facts (250 + 495 + 0 + 0 + 250 MT over 4.5 + 10.1 + 0 + 0 + 4.5 hrs) reproduces 52.094 exactly.\n\nWHY RUNNING HOURS COME FROM THE PRODUCTION REPORT AND NOT FROM THE STOPPAGE FORM: (1440 − Σ CM-2 stoppage minutes) ÷ 60 is computable from the stoppage facts and, on the days where both exist, lands within ~0.1 TPH of this figure — but it is not what the plant\'s report divides by, it would make a Production KPI depend on a form another department owns, and it fails exactly where it would need to help: the stoppage form and the Production Report\'s running-hours column both stop on 2026-06-30, so it buys no extra coverage at all. The hours here also come from the same row, the same form and the same submitter as the tonnage, so the two can never disagree about which day they describe.\n\nWHEN IT IS NULL: a day with no reported running hours (Σ hours = 0) is null, not zero — it is an unmeasured rate, and averaging zeros in would invent a collapse that never happened. A day with hours but zero tonnage is also null rather than 0 TPH, following the same pos() convention Kiln Output uses; in this dataset every such day (e.g. 2026-06-09, 1.47 OPC hours against no tonnage) is the missing-OPC-tonnage artifact described below, not a real zero-output shift.\n\nMonthly figure is the running-hours-weighted mean of the daily rate, which is algebraically Σ production ÷ Σ hours — the same thing the Excel\'s own MTD columns give (K45 ÷ G45) and the same shape cpp-plant-load-factor uses for the identical reason. A plain mean of daily rates would let a 1.5-hour day count as much as a 24-hour one.\n\nDATA GAP, QUANTIFIED (2026-09-24, dev Postgres): 82 of 170 reported production days can compute this, all between 2026-04-01 and 2026-06-30. Every day from 2026-07-01 on arrives through the Odoo production autofill, whose rows carry 15–30 fields against 86–94 on a manual day and include no running hours at all. Separately, 35 Apr–Jun days carry CM-2 OPC running hours (80.65 hrs in total) with cm2_opc_mt stored as 0, so the denominator counts hours whose tonnage is missing: over Apr–Jun the stored facts give 91,969 MT ÷ 1,637.99 hrs = 56.15 TPH, where removing those unmatched OPC hours gives 59.00 TPH, so the true figure is somewhere between. The April cross-check is sharper still — the Excel\'s MTD to 21 April is 22,062 MT ÷ 380.27 hrs = 58.02 TPH, while the stored facts give 20,572 ÷ 380.27 = 54.10, the 1,490 MT difference being precisely the workbook\'s CM-2 OPC MTD tonnage (K43). Stored hours match the workbook to the second decimal; only the OPC tonnage is missing. Backfilling cm2_opc_mt for Apr–Jun fixes this with no formula change.\n\nON THE 55 TPH TARGET: it is the plant\'s own Production KPI-tracker figure and the data supports it rather than contradicting it. Rated capacity on the same Excel row is 70 MT/hr; across the 82 computable days the daily rate runs min 46.9 / median 56.4 / max 64.2, clears 55 on 50 of them (61%), and never reaches rated capacity. Monthly: April 54.8, May 58.0, June 55.7 — the plant sits right on the target, which is what a correctly-set target looks like. Note those three figures are the UNDERSTATED ones; correcting the OPC gap moves all three up.',
      inputs: CM2_GRADES.concat(CM2_RUN_HRS),
      daily: function (f) {
        var hrs  = sumOf(CM2_RUN_HRS, f);
        var prod = pos(sumOf(CM2_GRADES, f));
        return (hrs > 0 && prod !== null) ? prod / hrs : null;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return sumOf(CM2_RUN_HRS, f); } },
    },

    'cement-mill-2-production': {
      label: 'Cement Mill 2 Production', unit: 'MT', dp: 0, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Cement ground by Cement Mill 2 that day, summed across all five grades (32.5N, 42.5R, 42.5N, OPC, 42.5N BM) — the source Excel\'s PLANT OPERATIONS table, CEMENT MILL -2 TOTAL row, PRODUCTION ON DATE cell (J45; 995 MT on 2026-04-21, which the stored facts for that day reproduce). No target: the plant states a rate target for CM-2 (see cement-mill-2-output, ≥ 55 TPH) but no daily tonnage target, and none is invented here — the same reasoning as cement-produced-day and despatch-day. Monthly figure is the mean of the days that reported, i.e. a MT/day rate, not a period total.\n\nThis exists alongside cement-mill-2-output because the two have very different coverage, and the difference is the whole point. Output needs running hours, which only manually-filed Production Reports carry, so it stops at 2026-06-30 (82 days). Production needs only the tonnages, which the Odoo autofill does supply, so it covers 160 of the 170 reported days from 2026-04-01 to 2026-09-22 — mean 1,172 MT/day, by month 1,014 / 1,151 / 1,209 / 1,316 / 1,317 / 869 (Apr…Sep, September being a partial month). Anywhere CM-2 has to show a figure for a recent month, this is the one that exists; do not substitute it into a TPH card, because a tonnage judged against a 55 TPH target is meaningless.',
      inputs: CM2_GRADES,
      daily: function (f) { return pos(sumOf(CM2_GRADES, f)); },
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
        /* Guard the POWER side too, not just production. cementProd comes from
           the production form while every kWh input comes from power-cons, so
           a day with production filed and no power reading used to fall
           through: sumOf() read each missing kWh as 0, the kilnProd branch
           below took its `: 0` fallback, and the KPI returned a hard 0 —
           rendered as "0 kWh/MT eq. cement", which reads as perfect
           efficiency rather than absent data. That is exactly what the whole
           of Sep 2026 showed (no power-cons row exists after 2026-06-30)
           while every sibling SPC/STE formula correctly returned null. */
        if (!anyReading(KWH_CLINKER, f) && !anyReading(KWH_DOWNSTREAM, f)) return null;
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
        if (!prod) return null;
        /* Same false-zero trap as specific-power-consumption-total: the guard
           above only proves clinker tonnage was recorded, and sumOf() reads
           every absent kWh as 0, so a day with tonnage and no meter reading
           returned 0 kWh/MT clinker rather than "unknown". */
        if (!anyReading(KWH_CLINKER, f)) return null;
        return sumOf(KWH_CLINKER, f) / prod;
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
      label: 'Blaine 425R', unit: 'm²/kg', dp: 0, version: 2,
      target: 380, signage: '>=', targetLabel: 'TBS 380–410',
      notes: 'Daily Blaine fineness of the 42.5R grade ground on Cement Mill-1, as measured by the quality lab. Reported in m²/kg, the unit the QC Daily Report and the TBS requirement it prints are both written in — v1 declared cm²/g and a 3,500 floor, which is the same specification expressed ten times larger. The TBS band is 380–410; the signage is a floor because a Blaine above the band is a grinding-cost question, not a product-conformance one.',
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
      notes: 'Captive Power Plant heat rate (Plant, 3300 @ MCR basis), matching FRM-LCL-PP-06\'s own formula cell: Boiler Steam Generation × (Superheated Steam Enthalpy − Feedwater Enthalpy) × 1000 ÷ (Gross Generation × Boiler Efficiency). The source Excel hardcoded that day\'s enthalpy/efficiency readings straight into the formula; power-plant-report.html (since 2026-09-05) instead collects them as their own daily inputs (cpp_superheated_steam_enthalpy, cpp_feedwater_enthalpy, cpp_boiler_efficiency) and auto-computes cpp_heat_rate_plant from them client-side before save, so this fact still reads a plain stored number. Still not coal×GCV÷gross_gen — that naive formula was verified against the source workbook to differ slightly, since coal energy input and the boiler\'s actual steam enthalpy gain are independently measured quantities. Monthly figure is the gross-generation-weighted mean.',
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

    /* ── CPP summary-strip KPIs, promoted from power-plant-report.html's
       own inline script ─────────────────────────────────────────────────
       Added 2026-09-16 alongside power-plant.html, the third split-report
       review page (same pattern as production.html and dispatch.html).
       Until now these five were computed only in power-plant-report.html's
       own KPI_TILES array (cpp_gross_gen, cpp_net_gen, cpp_plf, cpp_coal,
       cpp_sfc — see that page's CPP_COMPUTES) and never reached the
       registry, so they had no target/notes any other page could read and
       no MTD/YTD rollup outside that one form's own script. The arithmetic
       below is copied verbatim from CPP_COMPUTES and from the entry form's
       own weighted MTD/YTD block (computeRatios()) — this is a relocation,
       not a redesign. Two of the five (Gross Generation, Coal Consumed)
       carry no target: neither is stated anywhere in the plant's reporting
       for the raw quantity — only the ratios built from them (Auxiliary
       Power %, Specific Fuel Consumption) carry a stated target, so none is
       invented here for the raw figures (same reasoning as despatch-day and
       cement-produced-day, which are also target-less MT/day facts). ───── */

    'cpp-gross-generation': {
      label: 'Gross Power Generation', unit: 'kWh', dp: 0, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Total power generated by the Captive Power Plant that day, read directly off the CPP report (cpp_gross_gen_kwh) — FRM-LCL-PP-06 row 1. No target is declared for raw output anywhere in the plant\'s reporting; Auxiliary Power and Heat Rate carry the plant\'s actual efficiency targets instead. Monthly figure is the straight sum across reported days, matching the CPP report\'s own MTD/YTD rollup for this field (data-roll-mtd/data-roll-ytd).',
      inputs: ['cpp_gross_gen_kwh'],
      daily: function (f) { return pos(f.cpp_gross_gen_kwh); },
      monthlyAgg: 'sum',
    },

    'cpp-net-generation': {
      label: 'Net Power Exported', unit: 'kWh', dp: 0, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Net power exported = Gross Generation − Auxiliary Power Consumption (both on the CPP report), matching FRM-LCL-PP-06 row 3 and power-plant-report.html\'s own cpp_net_gen tile. No target is stated for this figure in the source report — only Auxiliary Power\'s own percentage is capped (see cpp-auxiliary-power). Monthly figure is Σgross − Σaux over the period, which is identical to summing each day\'s own net figure and matches the entry form\'s own weighted MTD/YTD block.',
      inputs: ['cpp_gross_gen_kwh', 'cpp_aux_kwh'],
      daily: function (f) {
        var g = pos(f.cpp_gross_gen_kwh);
        return g ? g - z0(f.cpp_aux_kwh) : null;
      },
      monthlyAgg: 'sum',
    },

    'cpp-plant-load-factor': {
      label: 'Plant Load Factor', unit: '%', dp: 1, version: 1,
      target: 80, signage: '>=', targetLabel: 'Target ≥ 80% PLF',
      notes: 'Average power generation as a share of the plant\'s 10 MW installed capacity: (Gross Generation(kWh) ÷ 1000 ÷ Running Hours) ÷ 10 MW × 100, matching FRM-LCL-PP-06 row 7 and power-plant-report.html\'s own cpp_plf tile/table row. 80% is the plant\'s stated PLF target (the entry form\'s own tile label). Monthly figure is the Running-Hours-weighted mean of the daily percentage — algebraically identical to computing the ratio from period totals (Σgross ÷ 1000 ÷ Σhours ÷ 10 × 100), the same arithmetic the entry form\'s own MTD/YTD rollup uses, just expressed as a weighted mean so it fits the registry\'s monthlyAgg shape.',
      inputs: ['cpp_gross_gen_kwh', 'cpp_run_hrs'],
      daily: function (f) {
        var g = pos(f.cpp_gross_gen_kwh), h = pos(f.cpp_run_hrs);
        return (h > 0) ? (g / 1000 / h) / 10 * 100 : null;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return pos(f.cpp_run_hrs) || 0; } },
    },

    'cpp-coal-consumption': {
      label: 'Coal Consumed (Boiler)', unit: 'MT', dp: 1, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Coal consumed by the CPP boiler that day, read directly off the CPP report (cpp_coal_cons) — the same fact cpp-specific-fuel-consumption divides by generation. No target is declared for raw boiler coal tonnage; the plant\'s actual fuel-efficiency target is on Specific Fuel Consumption instead. Monthly figure is the straight sum across reported days, matching the CPP report\'s own MTD/YTD rollup for this field.',
      inputs: ['cpp_coal_cons'],
      daily: function (f) { return pos(f.cpp_coal_cons); },
      monthlyAgg: 'sum',
    },

    'cpp-specific-fuel-consumption': {
      label: 'Specific Fuel Consumption', unit: 'kg/kWh', dp: 2, version: 1,
      target: 0.90, signage: '<', targetLabel: 'Target < 0.90 kg/kWh',
      notes: 'Coal consumed (MT) × 1000 ÷ Gross Generation (kWh), matching FRM-LCL-PP-06\'s own Specific Fuel Consumption row and power-plant-report.html\'s own cpp_sfc tile/table row. Monthly figure is the gross-generation-weighted mean, algebraically identical to the ratio of period totals (Σcoal × 1000 ÷ Σgross) — the same arithmetic the CPP report\'s own MTD/YTD rollup (computeRatios) already uses.',
      inputs: ['cpp_coal_cons', 'cpp_gross_gen_kwh'],
      daily: function (f) {
        var g = pos(f.cpp_gross_gen_kwh), coal = pos(f.cpp_coal_cons);
        return (g > 0 && coal > 0) ? coal * 1000 / g : null;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return pos(f.cpp_gross_gen_kwh) || 0; } },
    },

    /* ── Packing plant & open orders ───────────────────────────────────
       Added 2026-09-15. These three were live on the Dispatch & SO form
       for months as page-local initKpiLive() rules, which meant the
       figures a packing officer and a plant head read on that screen were
       invisible to the KPI Tracker, to Trends & Analytics, to the MIS pack
       and to the override/audit trail — and their targets were typed into
       the page as strings that had already drifted apart between pages
       ("Target: < 0.30%" on index.html vs "Target: ≤ 0.30%" on the form).
       The arithmetic below is unchanged from what that page computed; only
       its home has changed. ────────────────────────────────────────────── */

    'bags-packed': {
      label: 'Bags Packed', unit: 'bags', dp: 0, version: 1,
      target: 7000, signage: '>=', targetLabel: 'Target ≥ 7,000 bags/day',
      notes: 'Bags filled that day, as entered on the Dispatch & SO report: bags_pl1 (42.5 R) + bags_pl2 (42.5 N / B-M). Despite the field names these are GRADES, not packing lines — see the Burst Bag Rate notes. The 7,000/day target is the packing plant\'s standing daily plan and was previously typed into forms/dispatch-form.html rather than declared anywhere. Monthly figure is the mean of the days that reported, not a month total — the target is a per-day one, so comparing a monthly sum against it would be meaningless. Days with no dispatch report filed are excluded from that mean rather than counted as zero.',
      inputs: ['bags_pl1', 'bags_pl2'],
      daily: function (f) {
        var a = pos(f.bags_pl1), b = pos(f.bags_pl2);
        return (a === null && b === null) ? null : z0(f.bags_pl1) + z0(f.bags_pl2);
      },
      monthlyAgg: 'avg',
    },

    'burst-bag-rate': {
      label: 'Burst Bag Rate', unit: '%', dp: 2, version: 1,
      target: 0.30, signage: '<', targetLabel: 'Target < 0.30%',
      notes: "Share of packed bags that burst, weighted by the bags actually packed. NOTE ON THE FIELD NAMES: burst_rate_pl1/bags_pl1 hold the 42.5 R figures and burst_rate_pl2/bags_pl2 the 42.5 N / B-M figures \u2014 the \"pl1\"/\"pl2\" suffixes read like packing lines but have always been GRADES, because on the Dispatch & SO report both sit in the same Packing Line 1 column. The real per-line split was never captured: that column had no field behind it at all until it was removed on 2026-09-15, so capturing output per line needs new fields and a migration. This is therefore the grade-weighted plant rate: a grade that ran 6,930 bags counts for more than one that ran 600, and a plain average of the two percentages would misstate the plant figure whenever the grades run unevenly, which is most days. Monthly figure is weighted the same way, by each day of the period's total bags. Target < 0.30% is the packing plant's standing quality limit.",
      inputs: ['burst_rate_pl1', 'burst_rate_pl2', 'bags_pl1', 'bags_pl2'],
      daily: function (f) {
        var b1 = z0(f.bags_pl1), b2 = z0(f.bags_pl2), tot = b1 + b2;
        if (!tot) return null;
        return (z0(f.burst_rate_pl1) * b1 + z0(f.burst_rate_pl2) * b2) / tot;
      },
      monthlyAgg: { type: 'weighted', weight: function (f) { return z0(f.bags_pl1) + z0(f.bags_pl2); } },
    },

    'so-pendency': {
      label: 'SO Pendency', unit: 'MT', dp: 0, version: 1,
      target: null, signage: null, targetLabel: null,
      notes: 'Open sales orders still to be fulfilled, summed across every channel and grade (42.5R, 42.5N B-M, 42.5N, 32.5N, OPC 42.5N, Bulker, Big Bags and Clinker) as entered on the Dispatch & SO report. This is a STOCK, not a flow: it is the balance standing open on that date, so it is never summed across days — the monthly figure is the mean of the daily balances, and a day with no report is left out of that mean rather than read as zero pendency. There is no target: pendency is a demand signal to be read against dispatch capacity, not a number to be minimised on its own.',
      inputs: SO_PENDENCY,
      daily: function (f) {
        var any = SO_PENDENCY.some(function (k) { return pos(f[k]) !== null; });
        return any ? sumOf(SO_PENDENCY, f) : null;
      },
      monthlyAgg: 'avg',
    },
  };

  var api = { FACTS: FACTS, FORMULAS: FORMULAS, REGISTRY_VERSION: 1 };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NyatiFormulas = api;

}(typeof window !== 'undefined' ? window : globalThis));
