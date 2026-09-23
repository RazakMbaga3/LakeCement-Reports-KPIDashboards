/*
  services/odooDispatchSync.js — maps the Odoo dispatch report's raw
  (date, grade, channel, quantity) rows onto forms/dispatch-form.html's
  known field keys, and upserts into daily_reports (form_type='dispatch').

  Scope note: this feeds the standalone Dispatch report (dispatch-form.html)
  with real channel×grade breakdowns. It does NOT feed the main dashboard's
  "Despatch / Day" KPI card;
  that formula was re-pointed to the Production Report's CM-1 stock ledger
  on 2026-07-31 (see forms/formula-registry.js, 'despatch-day' v4) because
  the Dispatch form's own numbers drifted from what Operations reconciles
  against. The DISPATCH fact keys this writes into have no formula
  consumer at all right now — populating them is still real value (the
  report itself), just not a KPI-card fix.

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

  A distinct 'Big Bag' channel (dispatch_bag_*) has never appeared in any
  Odoo sample pulled so far — deliberately NOT mapped by guesswork. If it
  shows up in a future pull it lands in the "unmapped" bucket below
  (logged with a sample) rather than being silently dropped or filed
  under the wrong key. Same for any channel×grade combination this form
  has no field for at all (e.g. dispatch_bag_* only covers 3 of the 5
  grades) — unmapped, never force-written to an invented key.

  grade 'CEMENT B-M 42.5 N' — surfaced 2026-09-09 in production's first
  historical backfill (3 March rows, unmapped). Briefly mapped to
  dispatch_*_425nbm on the assumption it was the long-anticipated
  '42.5N B-M' grade with its words reordered — WRONG, corrected the same
  day: it's actually the Duramax 42 marketing name (confirmed against
  services/sales.js's Odoo product catalogue — Duramax 42 = product code
  FG005, whose real Odoo name is this exact string). dispatch-form.html
  has no field for Duramax at all, so this stays deliberately UNMAPPED —
  filing it under dispatch_*_425nbm would have meant real Duramax
  tonnage silently misreported as 42.5N B-M, which is worse than an
  honest "unmapped" bucket. Adding a Duramax column to the Dispatch
  report is a real, separate ask — not done here without sign-off, since
  it changes a form the plant actively fills in.
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
  // 'CEMENT B-M 42.5 N': Duramax 42 — no dispatch-form field exists yet, see header note
};
const OUT_OF_SCOPE_GRADES = new Set(['SCRAP STEEL']); // not a cement dispatch

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
  /* status 'approved' explicitly: daily_reports.status DEFAULTS to 'draft'
     (migration 010), and everything that reads the table for analysis now
     ignores drafts (REPORTED_STATUSES in config/forms.js). A figure pulled
     from the ERP is authoritative reported data, not somebody's unfinished
     entry, and there is no human in the loop to sign it off — so leaving it
     to the default would have made every synced day invisible to the KPI
     engine, the MIS pack and Entry Completeness.

     ON CONFLICT leaves status alone: if an operator has since submitted or
     had that day rejected, the sync's fresher figures merge in without
     overriding the human decision about the record. */
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
