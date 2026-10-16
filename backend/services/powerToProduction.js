/*
  services/powerToProduction.js — fills the Production Report's
  "TOTAL UNIT CONSUMED (kWh)" row (form_type 'production', the nine
  spc_*_kwh fields in daily-report.html's Specific Power section) from the
  Electrical department's Power Consumption report (form_type 'power-cons').

  Until now the production officer retyped those numbers from Electrical's
  sheet — or, from July on, nobody did: no post-June production row carries a
  single spc_* key, so production.html's Specific Power table has been blank
  for every Odoo-filled day. Electrical's own form already holds the same
  meter readings. This copies the ones that are provably the same figure.

  ── THE MAPPING, AND WHY EACH LINE IS (OR IS NOT) HERE ───────────────────

  Measured 2026-10-15 on the dev database, Apr–Jun 2026: 91 days on which
  BOTH reports exist, both seeded from the plant's own workbooks (power-cons
  from the IMS power workbooks' CUMULATIVE DAILY sheet, production from the
  Master Production Report's "Daily unit" sheet — two different files kept by
  two different departments). A day "matches" when the production figure and
  the power-cons figure differ by at most EQUAL_TOLERANCE_KWH (1 kWh — the
  production sheet stores whole kWh, so a sum of two 2-dp readings may round
  by up to 1).

    spc_crusher_kwh  = pwr_crusher_kwh                         87/91
    spc_rm1_kwh      = pwr_rawmill_kwh + pwr_rawmill2_kwh      86/91
    spc_kiln_kwh     = pwr_kiln_kwh                            87/91
    spc_coalmill_kwh = pwr_coalmill_kwh                        88/91
    spc_cemmill_kwh  = pwr_cm1_kwh + pwr_cm2_kwh               82/91 (85/91 within 10 kWh)
    spc_pplant_kwh   = pwr_packing_kwh + pwr_packing2_kwh      83/91 (86/91 within 10 kWh)
    spc_others_kwh   = UTILITIES + pwr_colony_kwh              87/91

  The sums are the plant's own definitions, not inferences from the totals:
  in every month's "Daily unit" sheet RAW MILL-1 is the formula =N+O
  ("R/M1 POWER" + "R/M2 POWER") and CEMENT MILL is =R+S ("CEM1 POWER" +
  "CEM2 POWER"). A raw-mill-1-only mapping matched 0/91 days.

  The misses are the two workbooks disagreeing, not the mapping:
    • 2026-05-31, 2026-06-02 and 2026-06-30 miss in EVERY column. The
      production master's 2 June row is a verbatim copy of its 1 June row
      (1,799 / 61,873 / 14,026 … in both), and the two month-end days were
      evidently typed before the IMS month-end close.
    • 2026-04-27 crusher: the production master says 74,825 kWh (its own
      TOTAL row carries it to 293,580); the IMS meter says 2,822 — a typo
      on the production side.
    • The rest are differences of 1–541 kWh in one to three columns on
      04-13, 05-15, 05-26, 06-03, 06-05, 06-06 and 06-25 (06-03/05/06 are
      3–9 kWh on ~100,000 — which is all that separates cemmill's 82 and
      pplant's 83 from 85 and 86).

  Cross-checked on the two days for which the repo also has the DAILY
  Power Consumption report (the workbook Electrical actually sends now, and
  the one forms/excel-import.js imports) next to that day's Production
  Report, by running the browser's own importer over both files:
    21.04.2026 — all 7 fields match the Production Report's row 54.
    30.08.2026 — 5 of 7 match. RAW MILL-1 reads 41,762 against Electrical's
                 42,054.21 and PYRO-KILN 57,096 against 56,804.26: the
                 production officer moved 292 kWh from raw mill to kiln, and
                 the two together still agree to the kWh. Neither file says
                 why. If the officer keeps doing this, their typed figures
                 win (see THE RULES) and the difference is logged.

  UTILITIES is one meter group under two field names. The IMS workbooks
  called it "UTILITIES" and the Apr–Jun import stored it as pwr_utils_kwh;
  the daily report calls the same line "Plant Lighting, Welding DB & CCR",
  and since 2026-09-22 the form's "UTILITIES" row stores it as
  pwr_lighting_kwh. Proof it is one quantity: on 2026-04-21 the stored
  pwr_utils_kwh (from IMS) and the daily report's Plant Lighting line are
  both 2,982.94. The production column is headed "OTHERS — Water pump,
  Utility, Factory & Colony", and utilities + colony reproduces it on 87/91
  Apr–Jun days and on both daily-report days (5,343.48 → 5,344;
  5,494.48 → 5,495). The current field is preferred; the legacy one is read
  only when the current one is blank, and if both are filled with different
  numbers the field is skipped rather than guessed.

  Deliberately NOT mapped:
    spc_rm2_kwh    — the plant writes a literal 0 here (RAW MILL-2 = 0 in
                     every Daily unit sheet) because RM-2's kWh is already
                     inside RAW MILL-1 above. Copying pwr_rawmill2_kwh here
                     would count it twice in the row's TOTAL; writing the 0
                     would be a fabricated zero. Left to the officer.
    spc_losses_kwh — the Power Consumption form has no losses field. The
                     daily report prints "Distribution losses" as a typed
                     figure (backup sheet B80, 1,492 on 21.04 and 1,919 on
                     30.08 — both equal to the production LOSSES column), but
                     the form's section list leaves it out. Deriving it as
                     (TANESCO + CPP) − Σ sections matched only 79/91 Apr–Jun
                     days (82/91 within 5 kWh) and went NEGATIVE on
                     2026-04-14 (−885 against 1,652): below the bar, and a
                     residual is an estimate, not a reading. Left manual.

  Odoo is not a source for any of this: its power meter readings stop in
  Dec 2025, and the "Power Units CPP/TANESCO" lines on its production
  entries are cost allocations, not meters.

  ── THE KPI LAYER (why this is a copy, not a registry repoint) ──────────

  None of the spc_*_kwh fields is a fact in forms/formula-registry.js. The
  specific-power KPIs (specific-power-consumption-total / -up-to-clinker /
  -cement-grinding, power-distribution-loss-pct) already read the pwr_*
  facts straight from the power-cons form, and formulaEngine.js resolves a
  fact only from the form the registry names. So this copy cannot feed any
  /api/formula figure twice, and nothing in the KPI layer can see two
  versions of the same reading. Repointing the registry at spc_* would do
  the opposite: make the KPIs depend on a downstream copy instead of the
  department that measures it. test/power-to-production.test.js asserts the
  registry keeps it that way. spc_* stay display fields of the Production
  Report, now filled from the source instead of retyped.

  ── THE RULES ────────────────────────────────────────────────────────────

    1. Only a REPORTED power-cons report is a source (approved or
       pending_approval — config/forms.js REPORTED_STATUSES, the same rule
       every KPI uses). A draft is unfinished typing; a rejected report is
       one the HOD said is wrong.
    2. Never write a zero or an estimate. A field is written only when all
       its required readings are present and the total is > 0. Optional
       parts (RM-2, Packing-2) may be blank: the Excel import puts a whole
       section's total in the first box when the sheet has no split, and
       the form's own section Total treats a blank the same way.
    3. Never overwrite a person's number. A production value that differs
       from the power figure is left alone and logged as a 'conflict' in
       production_power_copy — UNLESS it is a value this copy wrote itself
       and nobody has changed since (then a correction on the power report
       flows through), or it is blank/0.
         Why 0 counts as blank: daily-report.html pre-fills every spc_*
         input with value="0", so an officer who saves the form without
         touching the power row stores nine zeros. A stored 0 cannot be told
         apart from that untouched box, and a section the Power Consumption
         report shows drawing real power did not consume 0 kWh. To keep a
         different figure, the officer types it — that always wins.
    4. Remove only what we wrote. If the power figure goes away (report
       rejected or the field cleared) and the production row still holds the
       value this copy put there, it is removed — never replaced with 0.
    5. Never create a production row. A day with no Production Report is
       skipped; the copy happens when the row appears (the officer's save
       triggers it, and the reconcile script covers rows the Odoo autofill
       creates).
    6. Never touch status, approved_by or submitted_by — data only, with an
       atomic jsonb merge (`data = (data || patch) - removed`), so the Odoo
       autofill and the officer writing OTHER fields of the same row at the
       same moment are not clobbered. Every write lands in report_revisions
       as POWER_AUTOFILL / actor 'power-sync', the same way the Odoo
       autofill logs ODOO_AUTOFILL.

  Triggered from routes/reports.js after a power-cons or production save,
  and after a power-cons approve/reject; scripts/power-to-production-sync.js
  reconciles a date range (backfill, or rows the Odoo autofill created).
*/

const logger = require('./logger');
const { REPORTED_STATUSES } = require('../config/forms');
const { recordRevision }    = require('./reportRevisions');

/* Required on first use, not at load: the pure half (derivePowerFields,
   reconcileDay) is unit-tested with no database, and requiring db/index.js
   opens a pool that keeps the test process alive for its idle timeout. */
let _db = null;
function getDb() { return _db || (_db = require('../db')); }

const SOURCE_FORM = 'power-cons';
const TARGET_FORM = 'production';
const EQUAL_TOLERANCE_KWH = 1;

/* Each component is a list of ALTERNATIVE field names for one reading — the
   first is the current form's field, any later one a legacy name for the
   same meter. `required` components must all be present; `optional` ones
   add to the total when filled. See the header for the measurements. */
const UTILITIES = ['pwr_lighting_kwh', 'pwr_utils_kwh'];
const MAPPING = [
  { field: 'spc_crusher_kwh',  required: [['pwr_crusher_kwh']] },
  { field: 'spc_rm1_kwh',      required: [['pwr_rawmill_kwh']], optional: [['pwr_rawmill2_kwh']] },
  { field: 'spc_kiln_kwh',     required: [['pwr_kiln_kwh']] },
  { field: 'spc_coalmill_kwh', required: [['pwr_coalmill_kwh']] },
  { field: 'spc_cemmill_kwh',  required: [['pwr_cm1_kwh'], ['pwr_cm2_kwh']] },
  { field: 'spc_pplant_kwh',   required: [['pwr_packing_kwh']], optional: [['pwr_packing2_kwh']] },
  { field: 'spc_others_kwh',   required: [UTILITIES, ['pwr_colony_kwh']] },
];
const MAPPED_FIELDS = MAPPING.map(m => m.field);

/* Production fields this copy must never write, with the reason — kept as
   data so the test can assert they stay out of MAPPING. */
const NOT_MAPPED = {
  spc_rm2_kwh:    'plant reports 0; RM-2 kWh is already inside spc_rm1_kwh',
  spc_losses_kwh: 'no losses field on the Power Consumption form; derived residual matched 79/91',
};

function asNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const round2 = (n) => Math.round(n * 100) / 100;

/* One reading from its alternative names. Pure. */
function readComponent(powerData, names) {
  const present = names
    .map(name => ({ name, value: asNumber(powerData[name]) }))
    .filter(x => x.value !== null);
  if (!present.length) return { value: null, reason: `${names[0]} blank` };
  const first = present[0].value;
  if (present.some(x => Math.abs(x.value - first) > EQUAL_TOLERANCE_KWH)) {
    return { value: null, reason: `${present.map(x => `${x.name}=${x.value}`).join(' vs ')} disagree` };
  }
  return { value: first };
}

/* power-cons `data` -> { values: { spc field: kWh }, skipped: [{ field, reason }] }.
   Pure. Only fields that pass rule 2 appear in `values`. */
function derivePowerFields(powerData) {
  const values = {};
  const skipped = [];
  if (!powerData) {
    MAPPED_FIELDS.forEach(field => skipped.push({ field, reason: 'no reported Power Consumption report' }));
    return { values, skipped };
  }
  for (const m of MAPPING) {
    let total = 0;
    let reason = null;
    for (const names of m.required) {
      const r = readComponent(powerData, names);
      if (r.value === null) { reason = r.reason; break; }
      total += r.value;
    }
    if (!reason) {
      for (const names of m.optional || []) {
        const r = readComponent(powerData, names);
        if (r.value !== null) total += r.value;
        else if (/disagree/.test(r.reason)) { reason = r.reason; break; }
      }
    }
    if (!reason && !(total > 0)) reason = `total ${round2(total)} kWh is not a positive reading`;
    if (reason) skipped.push({ field: m.field, reason });
    else values[m.field] = round2(total);
  }
  return { values, skipped };
}

/* The decision for one day. Pure — no I/O.

     productionData — the production row's stored `data`
     derivedValues  — derivePowerFields(...).values
     copiedValues   — { field: value } this copy wrote earlier and recorded
                      in production_power_copy as state 'copied'

   Returns
     set       — { field: value } to merge into the production row
     remove    — fields to delete from it (rule 4)
     conflicts — [{ field, production_value, power_value }] left alone (rule 3)
     copied    — { field: value } the copy owns AFTER this run
     outcome   — { field: 'filled'|'updated'|'equal'|'conflict'|'removed'|'none' } */
function reconcileDay(productionData, derivedValues, copiedValues) {
  const data = productionData || {};
  const owned = copiedValues || {};
  const set = {};
  const remove = [];
  const conflicts = [];
  const copied = {};
  const outcome = {};

  for (const field of MAPPED_FIELDS) {
    const current = asNumber(data[field]);
    const power = field in derivedValues ? derivedValues[field] : null;
    const wrote = field in owned ? asNumber(owned[field]) : null;
    const ours = wrote !== null && current !== null && Math.abs(current - wrote) <= EQUAL_TOLERANCE_KWH;
    const placeholder = current === null || current === 0;

    if (power !== null) {
      if (current !== null && Math.abs(current - power) <= EQUAL_TOLERANCE_KWH) {
        outcome[field] = 'equal';
        if (ours) copied[field] = wrote;
      } else if (ours || placeholder) {
        set[field] = power;
        copied[field] = power;
        outcome[field] = ours ? 'updated' : 'filled';
      } else {
        conflicts.push({ field, production_value: current, power_value: power });
        outcome[field] = 'conflict';
      }
    } else if (ours) {
      remove.push(field);
      outcome[field] = 'removed';
    } else {
      outcome[field] = 'none';
    }
  }
  return { set, remove, conflicts, copied, outcome };
}

/* Rewrites this day's production_power_copy rows to match `plan`: one row
   per owned or conflicting field, none for the rest. state_since moves only
   when a field's state actually changes. */
async function saveCopyState(client, { date, shift, plan, derivedValues, productionData, powerStatus }) {
  const keep = [...Object.keys(plan.copied), ...plan.conflicts.map(c => c.field)];
  await client.query(
    `DELETE FROM production_power_copy
      WHERE record_date = $1 AND shift = $2 AND NOT (field = ANY($3::text[]))`,
    [date, shift, keep]);

  const rows = [
    ...Object.entries(plan.copied).map(([field, value]) => ({
      field, state: 'copied', copied: value,
      power: field in derivedValues ? derivedValues[field] : null,
      production: field in plan.set ? plan.set[field] : asNumber((productionData || {})[field]),
    })),
    ...plan.conflicts.map(c => ({
      field: c.field, state: 'conflict', copied: null, power: c.power_value, production: c.production_value,
    })),
  ];
  for (const r of rows) {
    await client.query(
      `INSERT INTO production_power_copy
         (record_date, shift, field, state, power_value, production_value, copied_value, power_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (record_date, shift, field) DO UPDATE SET
         state            = EXCLUDED.state,
         power_value      = EXCLUDED.power_value,
         production_value = EXCLUDED.production_value,
         copied_value     = EXCLUDED.copied_value,
         power_status     = EXCLUDED.power_status,
         state_since      = CASE WHEN production_power_copy.state = EXCLUDED.state
                                 THEN production_power_copy.state_since ELSE NOW() END,
         checked_at       = NOW()`,
      [date, shift, r.field, r.state, r.power, r.production, r.copied, powerStatus]);
  }
}

/* One day, one transaction. The production row is locked FOR UPDATE before
   anything is decided — the same lock the submit route and the Odoo
   autofill take — so a concurrent save cannot land between the read and the
   write. dryRun runs the identical path and rolls back. */
async function syncDay(date, { shift = 'day', dryRun = false } = {}) {
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');

    const powerRes = await client.query(
      'SELECT data, status FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3',
      [SOURCE_FORM, date, shift]);
    const power = powerRes.rows[0] || null;
    const powerStatus = power ? power.status : null;
    const reported = !!power && REPORTED_STATUSES.includes(power.status);
    const derived = derivePowerFields(reported ? power.data : null);

    const prodRes = await client.query(
      `SELECT data, status, approved_by, approved_at FROM daily_reports
        WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
      [TARGET_FORM, date, shift]);
    const prod = prodRes.rows[0] || null;
    if (!prod) {
      await client.query('ROLLBACK');
      return { date, shift, action: 'no_production_row', powerStatus, derived: derived.values, skipped: derived.skipped,
               set: {}, remove: [], conflicts: [], outcome: {} };
    }

    const ownedRes = await client.query(
      `SELECT field, copied_value FROM production_power_copy
        WHERE record_date = $1 AND shift = $2 AND state = 'copied' FOR UPDATE`,
      [date, shift]);
    const copiedValues = Object.fromEntries(ownedRes.rows.map(r => [r.field, r.copied_value]));

    const plan = reconcileDay(prod.data, derived.values, copiedValues);
    const changed = [...Object.keys(plan.set), ...plan.remove].sort();

    if (changed.length) {
      await client.query(
        `UPDATE daily_reports
            SET data = (data || $4::jsonb) - $5::text[], updated_at = NOW()
          WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
        [TARGET_FORM, date, shift, JSON.stringify(plan.set), plan.remove]);

      await recordRevision(client, {
        formType: TARGET_FORM, recordDate: date, shift, action: 'POWER_AUTOFILL',
        priorData:       prod.data,
        priorStatus:     prod.status,
        priorApprovedBy: prod.approved_by,
        priorApprovedAt: prod.approved_at,
        changedFields:   changed,
        actorId:         null,              // no human did this
        actorName:       'power-sync',
        reason:          `From the Power Consumption report for ${date} (${powerStatus || 'none'})`,
      });
    }

    await saveCopyState(client, {
      date, shift, plan, derivedValues: derived.values, productionData: prod.data, powerStatus,
    });

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');

    const action = changed.length ? (dryRun ? 'would_write' : 'wrote')
                 : plan.conflicts.length ? 'conflicts_only' : 'unchanged';
    if (plan.conflicts.length && !dryRun) {
      logger.warn({ date, conflicts: plan.conflicts },
        'power->production copy: Production report holds a different figure than the Power Consumption report — left as entered');
    }
    return { date, shift, action, powerStatus, derived: derived.values, skipped: derived.skipped,
             set: plan.set, remove: plan.remove, conflicts: plan.conflicts, outcome: plan.outcome };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is what matters */ });
    throw err;
  } finally {
    client.release();
  }
}

/* [from, to] inclusive: every day that has either report, or a copy-state
   row (so a removed/rejected source is cleaned up too). */
async function syncRange(from, to, { shift = 'day', dryRun = false } = {}) {
  const daysRes = await getDb().query(
    `SELECT record_date FROM daily_reports
      WHERE form_type = ANY($3::text[]) AND shift = $4 AND record_date BETWEEN $1 AND $2
     UNION
     SELECT record_date FROM production_power_copy
      WHERE shift = $4 AND record_date BETWEEN $1 AND $2
     ORDER BY 1`,
    [from, to, [SOURCE_FORM, TARGET_FORM], shift]);

  const summary = {
    from, to, shift, dryRun, days: 0,
    noProductionRow: 0, noReportedPower: 0, daysWritten: 0,
    fields: { filled: 0, updated: 0, equal: 0, conflict: 0, removed: 0, none: 0 },
    conflicts: [], writes: [],
  };
  for (const { record_date: date } of daysRes.rows) {
    const r = await syncDay(date, { shift, dryRun });
    summary.days++;
    if (r.action === 'no_production_row') { summary.noProductionRow++; continue; }
    if (!r.powerStatus || !REPORTED_STATUSES.includes(r.powerStatus)) summary.noReportedPower++;
    Object.values(r.outcome).forEach(o => { summary.fields[o]++; });
    if (r.action === 'wrote' || r.action === 'would_write') {
      summary.daysWritten++;
      summary.writes.push({ date, set: r.set, remove: r.remove });
    }
    r.conflicts.forEach(c => summary.conflicts.push({ date, ...c }));
  }
  return summary;
}

/* The route hook: never lets the copy fail the save that triggered it. */
async function syncAfterReportWrite(formType, date, shift = 'day') {
  if (formType !== SOURCE_FORM && formType !== TARGET_FORM) return null;
  try {
    return await syncDay(date, { shift });
  } catch (err) {
    logger.error({ err, formType, date, shift }, 'power->production copy failed — the report itself was saved');
    return null;
  }
}

module.exports = {
  MAPPING, MAPPED_FIELDS, NOT_MAPPED, UTILITIES, EQUAL_TOLERANCE_KWH,
  derivePowerFields, reconcileDay,
  syncDay, syncRange, syncAfterReportWrite,
};
