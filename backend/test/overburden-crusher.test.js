/*
  test/overburden-crusher.test.js — the pure halves of the two Mining feeds
  added 2026-10-15: overburden from Odoo's Waste Material Entry
  (services/odooWasteSync.js, services/overburden.js) and crusher TPH from
  the Production Report (services/crusher.js). No database, no Odoo.

  What is pinned here is the honesty of the numbers, not their plumbing:
    • only approved overburden counts; pending is separate; cancel is ignored
    • a date with no entry is null, never 0
    • TPH for a period is Σproduction ÷ Σapron-hours over days with BOTH,
      never a mean of daily TPHs, and never computed from a missing divisor

  Usage: node --test test/overburden-crusher.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseEntry } = require('../services/odooWasteSync');
const { summariseByDay, periodTotals } = require('../services/overburden');
const { crusherDays, crusherPeriod } = require('../services/crusher');

// ── Waste Material Entry rows ────────────────────────────────────────────

test('normaliseEntry: keeps Odoo\'s own quantity and state', () => {
  const e = normaliseEntry({ id: 634, name: 'WM/2026/0117', d: '2026-09-26', trans_id: 12,
    contractor: 'Remieli Rentals Limited', no_of_trips: 141, quantity: 2820, remarks: 'North Mine to Kizunga',
    state: 'approved', approval_status: 'approved', write_date: '2026-09-29 05:47:48.43' });
  assert.equal(e.odoo_id, 634);
  assert.equal(e.trips, 141);
  assert.equal(e.quantity_mt, 2820);
  assert.equal(e.entry_date, '2026-09-26');
  assert.equal(e.state, 'approved');
});

test('normaliseEntry: a quantity that is not trips × 20 is stored as Odoo has it', () => {
  /* WM/2026/0100: 26 trips, 502 t — the reason Sep is 128,062 t, not 128,080. */
  const e = normaliseEntry({ id: 617, d: '2026-09-15', no_of_trips: 26, quantity: 502, state: 'approved' });
  assert.equal(e.quantity_mt, 502);
});

test('normaliseEntry: a row without a usable id or date is refused', () => {
  assert.equal(normaliseEntry({ id: null, d: '2026-09-26' }), null);
  assert.equal(normaliseEntry({ id: 5, d: null }), null);
  assert.equal(normaliseEntry(null), null);
});

// ── Overburden totals ────────────────────────────────────────────────────

const ENTRIES = [
  { entry_date: '2026-09-26', state: 'approved', quantity_mt: 2820, trips: 141 },
  { entry_date: '2026-09-26', state: 'approved', quantity_mt: 1000, trips: 50 },
  { entry_date: '2026-09-27', state: 'cancel',   quantity_mt: 9999, trips: 999 },
  { entry_date: '2026-10-01', state: 'approved', quantity_mt: 7100, trips: 355 },
  { entry_date: '2026-10-02', state: 'waiting',  quantity_mt: 1300, trips: 65 },
];

test('summariseByDay: approved summed, pending kept apart, cancel ignored', () => {
  const days = summariseByDay(ENTRIES);
  const byDate = Object.fromEntries(days.map(d => [d.date, d]));
  assert.equal(byDate['2026-09-26'].mt, 3820);
  assert.equal(byDate['2026-09-26'].trips, 191);
  assert.equal('2026-09-27' in byDate, false, 'a cancelled entry must not even create the day');
  assert.equal(byDate['2026-10-02'].mt, null, 'a day with only pending entries has no approved figure');
  assert.equal(byDate['2026-10-02'].pendingMt, 1300);
});

test('periodTotals: on-date is null on a day with no entry — not recorded is not zero', () => {
  const t = periodTotals(summariseByDay(ENTRIES), '2026-10-03', '2026-10-01');
  assert.equal(t.mt.onDate, null);
  assert.equal(t.trips.onDate, null);
  assert.equal(t.mt.mtd, 7100);
  assert.equal(t.mt.ytd, 10920);
  assert.equal(t.pending.mt, 1300, 'pending is reported…');
  assert.equal(t.trips.ytd, 546, '…and never added in');
});

test('periodTotals: no approved entry anywhere stays null throughout', () => {
  const t = periodTotals(summariseByDay([{ entry_date: '2026-10-02', state: 'waiting', quantity_mt: 5, trips: 1 }]),
    '2026-10-02', '2026-10-01');
  assert.deepEqual(t.mt, { onDate: null, mtd: null, ytd: null });
  assert.equal(t.daysWithEntries, 0);
});

// ── Crusher TPH ──────────────────────────────────────────────────────────

const row = (d, prod, apron) => ({ record_date: d, data: {
  ...(prod === undefined ? {} : { ls_crusher_prod_mt: prod }),
  ...(apron === undefined ? {} : { ls_crusher_apron_hrs: apron }),
} });

test('crusherDays: TPH = production ÷ apron hours; missing hours give null, not 0', () => {
  const days = crusherDays([row('2026-10-12', 3293.64, 15.05), row('2026-10-13', 2000)]);
  assert.equal(days[0].tph, 218.85);
  assert.equal(days[1].tph, null);
  assert.equal(days[1].apronHrs, null);
});

test('crusherDays: a day with neither fact is dropped; two rows on one date are summed', () => {
  const days = crusherDays([row('2026-10-01'), row('2026-10-02', 100, 1), row('2026-10-02', 200, 1)]);
  assert.equal(days.length, 1);
  assert.equal(days[0].prodMt, 300);
  assert.equal(days[0].tph, 150);
});

test('crusherPeriod: MTD/YTD TPH is Σprod ÷ Σhours over paired days, not a mean of daily TPHs', () => {
  /* Day A 100 t in 1 h (100 TPH), day B 1,000 t in 10 h (100 TPH), day C
     2,000 t in 5 h (400 TPH). Mean of daily TPHs = 200; the true rate is
     3,100 ÷ 16 = 193.75. Day D has tonnes but no hours and must not enter
     the TPH numerator. */
  const days = crusherDays([
    row('2026-09-30', 100, 1), row('2026-10-01', 1000, 10), row('2026-10-02', 2000, 5), row('2026-10-03', 500),
  ]);
  const p = crusherPeriod(days, '2026-10-03', '2026-10-01');
  assert.equal(p.tph.ytd, 193.75);
  assert.equal(p.tph.mtd, 200, '3,000 t ÷ 15 h over the October paired days');
  assert.equal(p.tph.onDate, null, 'the 3rd has no hours, so no TPH');
  assert.equal(p.prod.mtd, 3500, 'production still sums every day that has it');
  assert.equal(p.apron.mtd, 15);
  assert.deepEqual(p.tphDays, { mtd: 2, ytd: 3 });
});

test('crusherPeriod: no apron hours anywhere means TPH null, never 0', () => {
  const p = crusherPeriod(crusherDays([row('2026-10-01', 1000), row('2026-10-02', 2000)]), '2026-10-02', '2026-10-01');
  assert.deepEqual(p.tph, { onDate: null, mtd: null, ytd: null });
  assert.deepEqual(p.apron, { onDate: null, mtd: null, ytd: null });
});
