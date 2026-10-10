/*
  services/odooDispatchSync.js — maps the Odoo dispatch report's raw
  (date, grade, channel, quantity) rows onto forms/dispatch-form.html's
  known field keys, and upserts into daily_reports (form_type='dispatch').

  Scope note: this feeds the standalone Dispatch report (dispatch-form.html)
  with real channel×grade breakdowns, AND — since 2026-10-10 — the
  "Despatch / Day" KPI ('despatch-day' v5 in forms/formula-registry.js),
  which sums the same fields as dispatch.html's "Cement Dispatched" card.
  Between 2026-07-31 and 2026-10-10 that KPI read the Production Report's
  CM-1 stock ledger instead; the ledger stopped being recorded in July, so
  this sync is now the KPI's only live source. If it stops, Total Dispatch
  on the Production Report goes blank.

  Mapping confirmed against real Odoo test data pulled 2026-08-04/05, and
  re-confirmed against the PRODUCTION ERP 2026-09-23 after the endpoint
  moved there (same 5 distinct product_grade values, same 3 distinct
  dispatch_channel values, live through 2026-09-22):
    channel  '50 Kg Bag' -> 'reg' (matches dispatch-form.html's existing
             so_/veh_ "REG" naming for the 50kg-bag channel)
    channel  'Bulker'    -> 'blk'
    channel  'MT'        -> out of scope: every row seen under this
             channel was product_grade 'SCRAP STEEL', not cement — skipped
             (logged, not silently dropped).
    grade    'CEMENT 42.5 R'      -> '425r'
    grade    'CEMENT 42.5 N'      -> '425n'
    grade    'CEMENT OPC 42.5 N'  -> 'opc425n'
    grade    'CEMENT 32.5'        -> '325n'  — ASSUMED equivalent to the
             app's '32.5N' grade (Odoo's label carries no N/R suffix, and
             this is the only 32.5-family field the app tracks). Not a
             byte-exact confirmed match — flag to the Odoo/quality team
             if this ever needs correcting.

  A 'Big Bag' channel (dispatch_bag_*) first appeared in Odoo on
  2026-09-04, but ONLY carrying FLY ASH — never cement. So the three Big
  Bag cement fields still have no confirmed Odoo source and remain
  deliberately unmapped: the channel existing is not evidence that a
  cement row under it would mean what dispatch_bag_* means. Map it the
  day real cement arrives there, not before. Same for any channel×grade
  combination this form has no field for at all (dispatch_bag_* covers
  only 3 of the 5 grades) — unmapped, never force-written to an invented
  key.

  grade 'CEMENT B-M 42.5 N' -> '425nbm'. This one has flipped twice; the
  history matters, because the reasoning that unmapped it was sound and
  still produced a wrong answer.

  Surfaced 2026-09-09 in production's first historical backfill, mapped to
  dispatch_*_425nbm, then un-mapped the same day on discovering it is
  product code FG005, whose marketing name is "Duramax 42" (services/
  sales.js). The inference was: the Dispatch report's '42.5 N B-M' column
  is a different thing from Duramax, so filing Duramax tonnage there would
  misreport it. Reasonable — and wrong on the premise. Duramax 42 IS the
  42.5 N B-M grade; "Duramax" is the marketing name and "42.5 N B-M" the
  plant's own name for the same product. Two independent confirmations:

    1. config/odooProductionMap.js has mapped FG005 -> '425n_bm' since it
       was written, so the Production Report side of this app has always
       treated them as one grade. Only this file disagreed.
    2. Plant-head confirmation 2026-09-28, with the Dispatch Report
       workbook for 27 Sept 2026 beside the app's own screen: Regular
       Bags 42.5 N B-M = 150 MT and Bulker 42.5 N B-M = 90 MT, against
       Odoo rows of exactly 150 and 89.58 MT under 'CEMENT B-M 42.5 N',
       and an app total 239.58 MT short of the workbook's on exactly
       those two cells.

  So the "honest unmapped bucket" was not honest in effect: it silently
  dropped every Duramax dispatch from the report from 2026-09-09 until
  this was fixed, and the only visible trace was a logger.warn nobody
  reads. See docs/pm/DECISIONS.md DEC-005.
*/
const db     = require('../db');
const logger = require('./logger');
const { fetchDispatchReport } = require('./odooDispatchClient');

const CHANNEL_PREFIX = {
  '50 Kg Bag': 'reg',
  'Bulker':    'blk',
  // 'Big Bag': 'bag',  -- not yet observed from Odoo; add once confirmed
};
const GRADE_SUFFIX = {
  'CEMENT 42.5 R':     '425r',
  'CEMENT 42.5 N':     '425n',
  'CEMENT OPC 42.5 N': 'opc425n',
  'CEMENT 32.5':       '325n', // see header note — assumed, not confirmed
  'CEMENT B-M 42.5 N': '425nbm', // Duramax 42 (FG005) = the 42.5 N B-M grade — see header note
};
/* Not cement dispatches. These are counted and logged as SKIPPED, which is
   the quiet, expected outcome — unlike UNMAPPED, which means "a row we
   should probably be reporting has nowhere to go" and is meant to be read
   as an alarm. Keeping known non-cement traffic out of the unmapped bucket
   is what lets that alarm stay meaningful: the Duramax rows sat in it for
   19 days among perennial fly-ash noise. Added 2026-09-28 after a sweep of
   every row since January:
     FLY ASH      36.58 MT over 2 days (Big Bag) — a raw material going out
     VEHICLE SOLD  0.10 MT over 2 days (Pcs)     — an asset disposal */
const OUT_OF_SCOPE_GRADES = new Set(['SCRAP STEEL', 'FLY ASH', 'VEHICLE SOLD']);

// Every field this mapping is allowed to write — matches dispatch-form.html
// data-field attributes exactly, so a mapping bug can never invent a field
// the form/report doesn't actually have.
const VALID_FIELDS = new Set([
  'dispatch_reg_425r', 'dispatch_reg_425nbm', 'dispatch_reg_425n', 'dispatch_reg_325n', 'dispatch_reg_opc425n',
  'dispatch_blk_425r', 'dispatch_blk_425nbm', 'dispatch_blk_425n', 'dispatch_blk_325n', 'dispatch_blk_opc425n',
  'dispatch_bag_425r', 'dispatch_bag_425nbm', 'dispatch_bag_425n',
]);

function mapRow(row) {
  if (OUT_OF_SCOPE_GRADES.has(row.product_grade)) return { skip: true };

  const prefix = CHANNEL_PREFIX[row.dispatch_channel];
  const suffix = GRADE_SUFFIX[row.product_grade];
  if (!prefix || !suffix) return { unmapped: true };

  const field = `dispatch_${prefix}_${suffix}`;
  if (!VALID_FIELDS.has(field)) return { unmapped: true };

  return { field };
}

/* Groups raw Odoo rows into { 'YYYY-MM-DD': { field: totalQty, ... } },
   plus everything skipped/unmapped so nothing vanishes without a trace. */
function buildDayMaps(rows) {
  const byDate = new Map();
  const unmapped = [];
  let skippedNonCement = 0;

  for (const row of rows) {
    const { field, unmapped: isUnmapped, skip } = mapRow(row);
    if (skip) { skippedNonCement++; continue; }
    if (isUnmapped) { unmapped.push(row); continue; }

    if (!byDate.has(row.dispatch_date)) byDate.set(row.dispatch_date, {});
    const dayData = byDate.get(row.dispatch_date);
    dayData[field] = (dayData[field] || 0) + row.quantity_dispatched_mt;
  }

  return { byDate, unmapped, skippedNonCement };
}

/* Merge-safe upsert: a day's other manually-entered dispatch-form fields
   (SO forecast, vehicle tracking, bag counts) are never overwritten —
   only the Odoo-sourced quantity fields get set. submitted_by/updated_by
   stay NULL (no human submitted this row; the schema allows it).

   The merge happens inside the SQL statement itself (jsonb `||`, right
   operand wins on key conflict) rather than a separate SELECT-then-write
   round trip — a read-modify-write here would race routes/reports.js's
   own atomic upsert on the exact same (form_type, record_date, shift) row
   if an operator edits the Dispatch form for a day while this sync (which
   deliberately re-pulls a 5-day trailing window every run) is mid-flight
   for that same day, silently discarding whichever write lost the race. */
async function upsertDay(date, odooFields) {
  /* status 'approved' — restored 2026-10-01, see DEC-008. This has moved
     twice, and the history is the point.

     It was 'approved' originally, which is right for what the dashboard
     needs: an ERP figure is reported fact, and 'draft' sits outside
     REPORTED_STATUSES so the review page and the KPI engine skip it. On
     2026-09-28 it became 'draft' to escape the write-lock in
     routes/reports.js, which was refusing the packing plant's manual
     entries on every date. That unlocked the form and broke the dashboard:
     every Dispatch & SO day dropped out of the reports management reads,
     showing "a draft exists for this date, but it has not been submitted"
     in place of the plant's own figures.

     Both problems came from one wrong assumption — that status alone says
     whether a report has been signed. It does not. The fix belongs in the
     lock, which now tests approved_by: an ERP row has approved_by IS NULL,
     so there is no human signature to protect and the day stays writable.
     A day a person approves gets approved_by set and locks normally.

     So this can be 'approved' — which is simply true, Odoo already
     approved it — AND the packing plant can still add SO Pendency, Bags
     Packed, Burst Bag Rate and the vehicle queue on top. The two goals
     were never actually in conflict; the old comment below explains what
     made them look like they were.

     ─── superseded reasoning, kept because it was nearly right ───
     This sync used to insert new days as 'approved', reasoning
     that an ERP figure is authoritative reported data with no human in the
     loop to sign it off, and that a 'draft' would be invisible to the KPI
     engine, the MIS pack and Entry Completeness (REPORTED_STATUSES in
     config/forms.js). The first half of that was sound; the conclusion
     collided with a rule added later.

     Since 2026-09-24 routes/reports.js refuses any submit over a report
     that is already 'approved' OR 'pending_approval' (code REPORT_LOCKED).
     Because this sync touches every dispatch day, it had pre-approved all
     208 of them — so the Dispatch & SO form was locked on EVERY date, and
     the half of it Odoo cannot supply could never be entered by anyone.
     That is why SO Pendency, Bags Packed, Burst Bag Rate and the 8 AM
     vehicle queue had been empty since the sync began: not a missing data
     entry, an impossible one. Zero dispatch rows have ever had a human
     submitter.

     'draft' was then the only status that left the day writable, so that is
     what this used — at the cost of the day no longer counting anywhere.
     That cost turned out to be the bigger problem: it is the dashboard
     management actually reads. The lock is what was wrong, not the status.
     ─── end superseded reasoning ───

     ON CONFLICT still leaves status alone: once an operator has submitted
     a day, or an HOD approved or rejected it, the sync's fresher figures
     merge in without overriding the human decision about the record. */
  await db.query(`
    INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_at, status)
    VALUES ('dispatch', $1, 'day', $2, NOW(), 'approved')
    ON CONFLICT (form_type, record_date, shift)
    DO UPDATE SET data = daily_reports.data || EXCLUDED.data, updated_at = NOW()
  `, [date, JSON.stringify(odooFields)]);
}

/* Pulls [from, to] (inclusive, 'YYYY-MM-DD') and upserts every day found.
   Returns a summary — used by odooSync.js's PULLS and the manual script. */
async function pullDispatchDailySummary(from, to) {
  const rows = await fetchDispatchReport(from, to);
  const { byDate, unmapped, skippedNonCement } = buildDayMaps(rows);

  for (const [date, fields] of byDate) {
    await upsertDay(date, fields);
  }

  if (unmapped.length) {
    logger.warn({ count: unmapped.length, sample: unmapped.slice(0, 5) },
      'odoo dispatch sync: unmapped grade/channel rows — not written anywhere, needs mapping review');
  }

  return {
    from, to,
    rowsReceived: rows.length,
    daysUpdated: byDate.size,
    rowsSkippedNonCement: skippedNonCement,
    rowsUnmapped: unmapped.length,
  };
}

module.exports = { pullDispatchDailySummary, mapRow, buildDayMaps };
