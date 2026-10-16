/*
  config/odooCppMap.js — which Odoo `cpp_entry` column fills which field of
  the Captive Power Plant daily report (form_type 'cpp', FRM-LCL-PP-06), and
  the evidence that each pairing is right.

  ── How every row below was verified (2026-10-15) ───────────────────────
  The dashboard's CPP rows for 2026-07-01..2026-09-20 were keyed from the
  plant's own FRM-LCL-PP-06 workbooks (migrations 020 + 023, approved by the
  'cpp' user) — an independent human copy of the same days Odoo holds. Every
  pairing was tested against those 77 days (and, for extra confidence,
  against all 168 seeded days 2026-04-01..2026-09-20), reading Odoo's
  state='complete' rows only. Counts are "exact match / days compared":
  equal to 0.005, i.e. to the Excel's own 2-dp precision. Period totals over
  the 77 days are identical to the unit: 13,111,151 kWh gross, 1,372,096 kWh
  auxiliary, 10,155 MT coal, 1,831.5 running hours.

  A pairing that matched on 76 of 77 is kept when — and only when — the one
  odd day is a disagreement between two human copies of the same reading
  (a typo in one of them), not a sign that the column means something else.
  Each such day is named below so nobody has to re-derive it.

  ── Two kinds of field, and why zero means different things in each ─────
  kind 'qty'  — a flow, count or total the officer records every day.
                Odoo's float columns default to 0, but these rows are
                state='complete' AND approval_status='approved' entries: a 0
                in them is the plant's own statement (no DG run, no fly-ash
                truck to the dump yard), and the Excel agrees — on every day
                the workbook carried a value, Odoo's zeros matched its zeros
                (dg_power 76/76, fly_ash_cement 76/76, fly_ash_dumpyard 77/77).
                So a 0 is written as 0.
  kind 'lab'  — a laboratory reading, a lab/DCS constant, or a ratio derived
                from them. A 0 here is physically impossible (no coal has a
                GCV of 0, no boiler an efficiency of 0) and in Odoo it means
                "not measured": complete entries on 2025-06-07, 2024-03-24,
                2024-02-18 and others carry coal_gcv_adb / gcv / fly_ash_gcv
                = 0 on days the plant clearly ran. Writing those zeros would
                be the fabricated-zero bug (2026-09-30 integrity audit), so a
                lab field that is 0, null or non-finite is OMITTED, never
                written.

  ── What is deliberately NOT here ───────────────────────────────────────
  • The derived rows Odoo also stores — net_power, auxiliary_power_out (aux
    %), avg_power, plf, specific_steam, specific_fuel — are computed by
    power-plant-report.html itself (CPP_COMPUTES), exactly as for the seeded
    days. scripts/import-cpp.js skipped them for the same reason: a second,
    driftable copy of the same number.
  • The twelve per-column heat-rate constants' _mtd / _ytd variants. They
    are an artefact of the workbook hard-coding constants separately into
    its MTD and YTD formula cells; Odoo holds one set per day. Leaving them
    out makes the page fall back to the generation-weighted mean of the
    daily heat rates, which is exact while the constants don't move — and
    it is what the 153 Apr–Aug seeded days already rely on.
  • cpp_coal_recv_* (coal received by supplier) — not in cpp_entry at all.
  • rate_per_kwh — no dashboard field.
*/

/* Each entry: dashboard field, Odoo column, kind, decimal places to round
   Odoo's float to (its doubles carry noise like 2764.3841214244017), and
   the measured agreement. `jul_sep` is the acceptance number; `apr_sep`
   adds the Apr–Jun seeded days. */
const CPP_FIELD_MAP = Object.freeze([
  // ── Power ──
  { field: 'cpp_gross_gen_kwh',   column: 'gross_power',      kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  { field: 'cpp_aux_kwh',         column: 'auxiliary_power',  kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  { field: 'cpp_run_hrs',         column: 'running_hrs',      kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  /* Absent from the Excel on 2026-09-06 (and 3 Apr–Jun days); Odoo 0 on
     each. Every day the workbook carried a figure: 76/76. */
  { field: 'cpp_dg_gen_kwh',      column: 'dg_power',         kind: 'qty', dp: 2, jul_sep: '76/76 (+1 blank in Excel)', apr_sep: '164/164' },

  // ── Steam & water ──
  { field: 'cpp_feed_water_mt',    column: 'feed_water',      kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  { field: 'cpp_boiler_steam_mt',  column: 'boiler_steam',    kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  { field: 'cpp_bleed_steam_mt',   column: 'bleed_steam',     kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  { field: 'cpp_turbine_steam_mt', column: 'turbine_steam',   kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  { field: 'cpp_condensate_mt',    column: 'condensate_gen',  kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  { field: 'cpp_aux_steam_mt',     column: 'auxiliary_steam', kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  { field: 'cpp_dm_water_gen_m3',  column: 'dm_water_gen',    kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  /* 2026-09-19: Excel 97.85, Odoo 97.45 — one digit, one day. Odoo's own
     heat rate (TG) for that day is computed from 97.45, consistently. */
  { field: 'cpp_dm_water_cons_m3', column: 'dm_water_cons',   kind: 'qty', dp: 2, jul_sep: '76/77 (09-19 typo)', apr_sep: '167/168' },
  { field: 'cpp_ct_makeup_m3',     column: 'ct_makeup_cons',  kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },

  // ── Fuel ──
  { field: 'cpp_coal_cons',        column: 'coal_consumption', kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
  /* 2026-09-02: Excel 4432, Odoo 4472 (and 2026-04-02 4607 vs 4602). */
  { field: 'cpp_coal_gcv',         column: 'coal_gcv_adb',     kind: 'lab', dp: 2, jul_sep: '76/77 (09-02 typo)', apr_sep: '166/168' },

  // ── Fly ash ──
  /* Odoo's column names are swapped against their meaning: `fly_ash_gcv`
     holds the COMBUSTIBLE % (15–34) and `gcv` holds the fly-ash GCV
     (1,200–2,700 kcal/kg). Matched by value, not by name — 2026-10-10 reads
     fly_ash_gcv 32 / gcv 2,673. Combustible %: 2026-08-12 Excel 15.7 vs
     Odoo 15.74 (Excel rounded); fly-ash GCV: 2026-09-01 Excel 1421 vs Odoo
     1412 (transposed digits). */
  { field: 'cpp_flyash_combustible_pct', column: 'fly_ash_gcv', kind: 'lab', dp: 2, jul_sep: '76/77 (08-12 rounding)', apr_sep: '165/168 (+3 rounding)' },
  { field: 'cpp_flyash_gcv',             column: 'gcv',         kind: 'lab', dp: 2, jul_sep: '76/77 (09-01 typo)',     apr_sep: '165/168' },
  /* 2026-07-13 is blank in the Excel (the memory note's known workbook
     defect) and 0 in Odoo; every day the workbook carried a figure: 76/76. */
  { field: 'cpp_flyash_to_cm_mt',        column: 'fly_ash_cement',    kind: 'qty', dp: 2, jul_sep: '76/76 (+1 blank in Excel)', apr_sep: '165/167' },
  /* 77/77 Jul–Sep. Apr–Jun is worse (152/168): 13 days of 2026-05-15..06-03
     carry 1–4 trucks in the Excel and 0 in Odoo, and 2026-05-14 has 42 in
     Odoo's coal-yard box — that day's cement-mill tonnage typed one field
     over. The pairing is right; Odoo's May entries were incomplete. Only
     2026-09-21 onward is written, where the record is clean. */
  { field: 'cpp_flyash_to_coalyard_nos', column: 'fly_ash_coalyard',  kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '152/168 (May gaps in Odoo)' },
  { field: 'cpp_flyash_to_dumpyard_nos', column: 'fly_ash_dumpyard',  kind: 'qty', dp: 2, jul_sep: '77/77', apr_sep: '166/166' },

  // ── Heat-rate constants (the Day column only — see header) ──
  /* Stored on the 15 Sep days (migration 023) and 15/15 equal there. Odoo:
     803 / 130 / 30 on every complete entry since April; boiler efficiency
     0.78 on 185 days, 0.77 on 4, 0.76 on 3 (incl. 2026-10-10/11/13). */
  { field: 'cpp_superheated_steam_enthalpy', column: 'steam_enthalpy',      kind: 'lab', dp: 4, jul_sep: '15/15 (Sep only)', apr_sep: '15/15' },
  { field: 'cpp_feedwater_enthalpy',         column: 'feed_water_enthalpy', kind: 'lab', dp: 4, jul_sep: '15/15 (Sep only)', apr_sep: '15/15' },
  { field: 'cpp_dm_water_enthalpy',          column: 'dm_water_enthalpy',   kind: 'lab', dp: 4, jul_sep: '15/15 (Sep only)', apr_sep: '15/15' },
  { field: 'cpp_boiler_efficiency',          column: 'boiler_efficiency',   kind: 'lab', dp: 4, jul_sep: '15/15 (Sep only)', apr_sep: '15/15' },

  // ── Heat rates ──
  /* Odoo computes both with the page's own formulas (computeHeatRateTG /
     computeHeatRatePlant in power-plant-report.html) from its own inputs —
     re-derived for all 192 complete entries since 2026-04-01: 192/192 each.
     So writing them keeps a day internally consistent with the inputs and
     constants written beside it. TG on 2026-09-19 differs from the Excel by
     0.35 kcal/kWh, entirely explained by that day's DM-water typo above. */
  { field: 'cpp_heat_rate_tg',    column: 'heat_rate_tg',    kind: 'lab', dp: 2, jul_sep: '76/77 (09-19, follows DM water)', apr_sep: '167/168' },
  { field: 'cpp_heat_rate_plant', column: 'heat_rate_plant', kind: 'lab', dp: 2, jul_sep: '77/77', apr_sep: '168/168' },
]);

/* Dashboard CPP fields that stay with the officer, and why — so "why didn't
   the autofill fill X" has an answer that doesn't need this file's history. */
const CPP_MANUAL_FIELDS = Object.freeze({
  cpp_superheated_steam_enthalpy_mtd: 'workbook MTD-column constant; Odoo has one set per day',
  cpp_superheated_steam_enthalpy_ytd: 'workbook YTD-column constant; Odoo has one set per day',
  cpp_feedwater_enthalpy_mtd: 'workbook MTD-column constant; Odoo has one set per day',
  cpp_feedwater_enthalpy_ytd: 'workbook YTD-column constant; Odoo has one set per day',
  cpp_dm_water_enthalpy_mtd: 'workbook MTD-column constant; Odoo has one set per day',
  cpp_dm_water_enthalpy_ytd: 'workbook YTD-column constant; Odoo has one set per day',
  cpp_boiler_efficiency_mtd: 'workbook MTD-column constant; Odoo has one set per day',
  cpp_boiler_efficiency_ytd: 'workbook YTD-column constant; Odoo has one set per day',
  cpp_coal_recv_market_insight: 'coal receipts by supplier are not in cpp_entry',
  cpp_coal_recv_connect: 'coal receipts by supplier are not in cpp_entry',
  cpp_coal_recv_stamico: 'coal receipts by supplier are not in cpp_entry',
  cpp_coal_recv_ruvuma: 'coal receipts by supplier are not in cpp_entry',
  cpp_coal_recv_mchekanai: 'coal receipts by supplier are not in cpp_entry',
  cpp_coal_recv_jitegemee: 'coal receipts by supplier are not in cpp_entry',
});

module.exports = { CPP_FIELD_MAP, CPP_MANUAL_FIELDS };
