/*
  services/odooDispatchSync.js — maps the Odoo dispatch report's raw
  (date, grade, channel, quantity) rows onto forms/dispatch-form.html's
  known field keys, and upserts into daily_reports (form_type='dispatch').

  Scope note: this feeds the standalone Dispatch report (dispatch-form.html)
  with real channel×grade breakdowns — it currently has zero real rows,
  ever. It does NOT feed the main dashboard's "Despatch / Day" KPI card;
  that formula was re-pointed to the Production Report's CM-1 stock ledger
  on 2026-07-31 (see forms/formula-registry.js, 'despatch-day' v4) because
  the Dispatch form's own numbers drifted from what Operations reconciles
  against. The DISPATCH fact keys this writes into have no formula
  consumer at all right now — populating them is still real value (the
  report itself), just not a KPI-card fix.

  Mapping confirmed against real Odoo test data pulled 2026-08-04/05 (5
  distinct product_grade values, 3 distinct dispatch_channel values
  observed in every sample so far):
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

  '42.5N B-M' (dispatch_reg_425nbm et al) and a distinct 'Big Bag' channel
  (dispatch_bag_*) have never appeared in any Odoo sample pulled so far —
  deliberately NOT mapped by guesswork. If either value shows up in a
  future pull it lands in the "unmapped" bucket below (logged with a
  sample) rather than being silently dropped or filed under the wrong key.
  Same for any channel×grade combination this form has no field for at
  all (e.g. dispatch_bag_* only covers 3 of the 5 grades) — unmapped,
  never force-written to an invented key.
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
  // 'CEMENT 42.5 N B-M': '425nbm', -- not yet observed from Odoo
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
   stay NULL (no human submitted this row; the schema allows it). */
async function upsertDay(date, odooFields) {
  const existing = await db.query(
    `SELECT data FROM daily_reports WHERE form_type='dispatch' AND record_date=$1 AND shift='day'`,
    [date]
  );
  const merged = { ...(existing.rows[0]?.data || {}), ...odooFields };

  await db.query(`
    INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_at)
    VALUES ('dispatch', $1, 'day', $2, NOW())
    ON CONFLICT (form_type, record_date, shift)
    DO UPDATE SET data = $2, updated_at = NOW()
  `, [date, JSON.stringify(merged)]);
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
