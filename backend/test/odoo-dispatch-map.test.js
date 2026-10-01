/*
  test/odoo-dispatch-map.test.js — the Odoo dispatch grade/channel mapping.

  Why this exists: services/odooDispatchSync.js had no test at all, and its
  mapping for one grade flipped twice on reasoning alone. 'CEMENT B-M 42.5 N'
  (product code FG005, marketed as Duramax 42) was mapped to the 42.5 N B-M
  fields, un-mapped the same day on the theory that Duramax and 42.5 N B-M
  were different products, and re-mapped 2026-09-28 once the plant head
  confirmed they are one grade under two names.

  The cost of that middle state is what these tests are really guarding:
  every Duramax dispatch — the plant's second-biggest grade — silently
  vanished from the Dispatch report for 19 days, because an unmapped row is
  dropped with nothing but a logger.warn to show for it. A mapping that can
  be argued either way needs an executable answer, not a comment.

  The quantities below are the real Odoo rows for 2026-09-27, checked
  against the plant's own Dispatch Report workbook for that date.

  No database, no Odoo, no HTTP.
  Usage: node --test test/odoo-dispatch-map.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');

const fs   = require('fs');
const path = require('path');

const { mapRow, buildDayMaps } = require('../services/odooDispatchSync');
const { REPORTED_STATUSES }    = require('../config/forms');

const SYNC_SRC    = fs.readFileSync(path.join(__dirname, '..', 'services', 'odooDispatchSync.js'), 'utf8');
const REPORTS_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');

const row = (product_grade, dispatch_channel, quantity_dispatched_mt,
             dispatch_date = '2026-09-27') =>
  ({ dispatch_date, product_grade, dispatch_channel, quantity_dispatched_mt });

/* The five (grade, channel) pairs Odoo actually returned for 27 Sept 2026,
   and the workbook figures they have to reproduce:
     Regular Bags  42.5 R      2,272      Bulker  42.5 R      30
     Regular Bags  42.5 N B-M    150      Bulker  42.5 N B-M  90
     Regular Bags  32.5 N        338                    total 2,879 */
const SEPT_27 = [
  row('CEMENT 42.5 R',     'Bulker',     29.84),
  row('CEMENT 42.5 R',     '50 Kg Bag', 2271.5),
  row('CEMENT B-M 42.5 N', 'Bulker',     89.58),
  row('CEMENT B-M 42.5 N', '50 Kg Bag',  150),
  row('CEMENT 32.5',       '50 Kg Bag',  338),
];

test("'CEMENT B-M 42.5 N' is the 42.5 N B-M grade, in every channel", () => {
  assert.deepEqual(mapRow(row('CEMENT B-M 42.5 N', '50 Kg Bag', 150)),
    { field: 'dispatch_reg_425nbm' });
  assert.deepEqual(mapRow(row('CEMENT B-M 42.5 N', 'Bulker', 89.58)),
    { field: 'dispatch_blk_425nbm' });
});

test('Duramax tonnage is never silently dropped as unmapped', () => {
  const { unmapped } = buildDayMaps(SEPT_27);
  assert.deepEqual(unmapped, [],
    "a real dispatch row landing in the unmapped bucket disappears from the " +
    "report with only a log line — this is the 2026-09-09 regression");
});

test('27 Sept 2026 reproduces the plant Dispatch Report workbook exactly', () => {
  const { byDate } = buildDayMaps(SEPT_27);
  const day = byDate.get('2026-09-27');

  assert.equal(day.dispatch_reg_425r,  2271.5);
  assert.equal(day.dispatch_reg_425nbm, 150);    // the cell that read empty
  assert.equal(day.dispatch_reg_325n,   338);
  assert.equal(day.dispatch_blk_425r,   29.84);
  assert.equal(day.dispatch_blk_425nbm, 89.58);  // the cell that read empty

  const total = Object.values(day).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 2879) < 1,
    `day total ${total} must match the workbook's 2,879 MT — it read 2,639.3 ` +
    'while the two B-M cells were unmapped');
});

test('the other four grades and both channels still map as before', () => {
  assert.deepEqual(mapRow(row('CEMENT 42.5 R',     '50 Kg Bag', 1)), { field: 'dispatch_reg_425r' });
  assert.deepEqual(mapRow(row('CEMENT 42.5 N',     '50 Kg Bag', 1)), { field: 'dispatch_reg_425n' });
  assert.deepEqual(mapRow(row('CEMENT OPC 42.5 N', '50 Kg Bag', 1)), { field: 'dispatch_reg_opc425n' });
  assert.deepEqual(mapRow(row('CEMENT 32.5',       'Bulker',    1)), { field: 'dispatch_blk_325n' });
});

test('non-cement is skipped, and a genuinely unknown grade stays unmapped', () => {
  assert.deepEqual(mapRow(row('CEMENT 99.9 Z', '50 Kg Bag', 1)), { unmapped: true });
  /* Cement in a Big Bag must not be guessed into dispatch_bag_*: the
     channel exists in Odoo but has only ever carried fly ash. This is the
     one case where unmapped is the right answer. */
  assert.deepEqual(mapRow(row('CEMENT 42.5 R', 'Big Bag', 1)), { unmapped: true });
});

/* Skipped, not unmapped. The unmapped bucket is the alarm for "a row that
   should be in the report isn't"; every known non-cement movement parked in
   it is noise that made the 19-day Duramax outage easy to miss. */
test('known non-cement movements are skipped quietly, not flagged as unmapped', () => {
  assert.deepEqual(mapRow(row('SCRAP STEEL',  'MT',      1)),    { skip: true });
  assert.deepEqual(mapRow(row('FLY ASH',      'Big Bag', 18.29)), { skip: true });
  assert.deepEqual(mapRow(row('VEHICLE SOLD', 'Pcs',     0.05)),  { skip: true });

  const { unmapped, skippedNonCement } = buildDayMaps([
    row('FLY ASH', 'Big Bag', 18.29), row('VEHICLE SOLD', 'Pcs', 0.05),
    row('CEMENT B-M 42.5 N', '50 Kg Bag', 150),
  ]);
  assert.equal(skippedNonCement, 2);
  assert.deepEqual(unmapped, []);
});

/* ── The status contract ──────────────────────────────────────────────
   This pair has broken twice, in opposite directions, and both times the
   damage was silent — no error, just a screen that was wrong.

   Round 1: the sync wrote 'approved' while routes/reports.js refused any
   submit over an 'approved' report. Each was reasonable alone; together
   they locked the Dispatch & SO form on every stored day, so SO Pendency,
   Bags Packed, Burst Bag Rate and the vehicle queue could not be entered
   by anyone, ever.

   Round 2: the sync was changed to 'draft' to escape that lock. Entry
   worked — and the dashboard went blank, because 'draft' is outside
   REPORTED_STATUSES, so dispatch.html counted no day at all and showed
   "a draft exists but it has not been submitted" on all 211 dates.

   The resolution (DEC-008): `status` never meant "signed", `approved_by`
   does. The lock now tests approved_by, so an ERP row can say the true
   thing about itself AND stay writable. These tests pin both halves —
   either one alone is an outage. */

test('the sync inserts a fresh day as approved, so the dashboard counts it', () => {
  /* To end-of-line, not to the first ')': the VALUES list contains NOW(),
     which would truncate the match before the status literal. */
  const insert = SYNC_SRC.match(/INSERT INTO daily_reports[\s\S]*?VALUES \(.*/);
  assert.ok(insert, "could not find the sync's INSERT statement");
  const status = insert[0].match(/'(draft|approved|pending_approval)'\s*\)?\s*$/);
  assert.ok(status, 'could not read the status literal out of the INSERT');
  assert.ok(REPORTED_STATUSES.includes(status[1]),
    `the sync inserts '${status[1]}', which is outside REPORTED_STATUSES ` +
    `(${REPORTED_STATUSES.join(', ')}) — dispatch.html and the KPI engine ` +
    'would then skip every synced day, which is what blanked the dashboard ' +
    'on 2026-09-28.');
});

test('the write-lock turns on a human signature, not on status alone', () => {
  /* Read the predicate out of the route rather than restating it, so this
     tracks the real rule. The sync writes a REPORTED status, so the ONLY
     thing keeping the form writable is that the lock also requires a human
     approver. If that condition is dropped, the packing plant is locked out
     of every date again and nothing else here will catch it. */
  const pred = REPORTS_SRC.match(/const lockedStatus\s*=[\s\S]*?;/);
  assert.ok(pred, 'could not find the lockedStatus predicate in routes/reports.js');

  assert.match(pred[0], /humanSigned/,
    'the lock no longer consults humanSigned/approved_by. With the sync ' +
    'writing an approved status, a status-only lock makes SO Pendency, ' +
    'Bags Packed, Burst Bag Rate and the vehicle queue unfillable on every ' +
    'date — see DEC-008.');

  const signed = REPORTS_SRC.match(/const humanSigned\s*=.*/);
  assert.ok(signed, 'humanSigned is referenced but never defined');
  assert.match(signed[0], /approved_by/,
    'humanSigned must be derived from approved_by — the column that records ' +
    'that a PERSON signed the report');
});

test('REPORTED_STATUSES still excludes draft, so a real draft stays uncounted', () => {
  /* The other guardrail: with the sync back on 'approved', nobody should
     "fix" anything by widening REPORTED_STATUSES. A genuine human draft —
     somebody still typing — must not reach the dashboard. */
  assert.deepEqual([...REPORTED_STATUSES].sort(), ['approved', 'pending_approval']);
  assert.ok(!REPORTED_STATUSES.includes('draft'));
});

test('a mapped field is always one the Dispatch form really has', () => {
  const FORM_FIELDS = new Set([
    'dispatch_reg_425r', 'dispatch_reg_425nbm', 'dispatch_reg_425n', 'dispatch_reg_325n', 'dispatch_reg_opc425n',
    'dispatch_blk_425r', 'dispatch_blk_425nbm', 'dispatch_blk_425n', 'dispatch_blk_325n', 'dispatch_blk_opc425n',
    'dispatch_bag_425r', 'dispatch_bag_425nbm', 'dispatch_bag_425n',
  ]);
  for (const grade of ['CEMENT 42.5 R', 'CEMENT 42.5 N', 'CEMENT OPC 42.5 N', 'CEMENT 32.5', 'CEMENT B-M 42.5 N']) {
    for (const channel of ['50 Kg Bag', 'Bulker']) {
      const { field } = mapRow(row(grade, channel, 1));
      assert.ok(FORM_FIELDS.has(field), `${grade} / ${channel} -> ${field} is not a form field`);
    }
  }
});
