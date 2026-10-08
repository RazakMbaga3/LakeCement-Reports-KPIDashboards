/*
  test/sales-aggregation.test.js — Sales dashboard aggregation on the Sale
  Register mirror (services/salesRegister.js + services/sales.js).

  Pure tests cover the grade builders. DB tests load a sandbox through the
  real sync path (odooSalesSync.storeDay) — March 2001 as the month under
  test, February 2001 as a partly synced previous month, May 2001 as a month
  with nothing at all, synthetic ids 9100000xx — then run getDashboard() and
  pin the rules that keep it honest:
    - a synced day with no invoices is a real 0; an unsynced day is null
    - non-cement invoices are excluded, as the Register excludes them
    - collections come from invoiced − outstanding, never from the feed's
      shared-receipt collection_amount
    - month-on-month only against a FULLY synced previous month
    - a month with no data reports null and honest statuses, never zeros
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const db     = require('../db');
const sales  = require('../services/sales');
const { storeDay } = require('../services/odooSalesSync');

// ── pure: grade builders ─────────────────────────────────────────────

const reg = (byGrade, mt) => ({
  mt, by_grade: { super42: 0, max32: 0, duramax42: 0, premiumopc: 0, other: 0, ...byGrade },
});

test('_buildRegisterGradeMix: four product lines, shares of the cement total', () => {
  const g = sales._buildRegisterGradeMix(reg({ super42: 75, max32: 25 }, 100));
  assert.deepEqual(g.map(x => x.key), ['super42', 'max32', 'duramax42', 'premiumopc']);
  assert.equal(g[0].share_pct, 75);
  assert.equal(g[1].mtd_actual_mt, 25);
});

test('_buildRegisterGradeMix: cement with no product line gets its own bucket, never folded into a grade', () => {
  const g = sales._buildRegisterGradeMix(reg({ super42: 90, other: 10 }, 100));
  const other = g.find(x => x.key === 'unmatched');
  assert.ok(other);
  assert.equal(other.mtd_actual_mt, 10);
  assert.equal(g.find(x => x.key === 'super42').mtd_actual_mt, 90);
});

test('_buildRegisterGradeTrend: one row per day, sorted, every grade present', () => {
  const rows = sales._buildRegisterGradeTrend({
    by_date_grade: { '2001-03-11': { max32: 5 }, '2001-03-10': { super42: 30, other: 2 } },
  });
  assert.deepEqual(rows.map(r => r.date), ['2001-03-10', '2001-03-11']);
  assert.equal(rows[0].super42, 30);
  assert.equal(rows[0].max32, 0);
  assert.equal(rows[0].unmatched, 2);
});

// ── DB: getDashboard over a sandbox loaded through storeDay ──────────

let nextId = 910000001;
const id = () => nextId++;

function invoice({ date, code, product, productCode, qty, uom = '50 KG BAG', total, residual,
  payment = 'paid', division = 'D1', zone = 'Zone A', receiptId }) {
  const invId = id();
  return {
    invoice_id: invId, invoice_number: `INV/SANDBOX/${invId}`, invoice_date: date,
    customer_id: Number(code.replace(/\D/g, '')), customer: `Customer ${code}`, customer_code: code,
    sale_order_id: invId, sale_order: `SO/${invId}`, sale_order_ids: `SO/${invId}`, sale_order_date: date,
    status: 'posted', payment_status: payment, salesperson_id: 1, salesperson: 'OFFICER',
    division_id: 1, division, zone_id: 1, zone, region_id: 1, region: 'R',
    total_amount: total, untaxed_amount: Math.round(total / 1.18), tax_amount: total - Math.round(total / 1.18),
    residual_amount: residual,
    collection_amount: 999999999,   // the shared-receipt trap: must never be summed
    currency: 'TZS', quantity: qty * 2,
    invoice_lines: [
      { line_id: id(), product_id: 1, product, product_code: productCode, quantity: qty, uom,
        rate: 1, amount: Math.round(total / 1.18) - 1000, taxed_amount: total },
      { line_id: id(), product_id: false, product: '', product_code: '', quantity: qty, uom: '',
        rate: 1080, amount: 1000, taxed_amount: 1180 },
    ],
    customer_receipts: receiptId ? [{ receipt_id: receiptId, receipt_number: `R/${receiptId}`,
      receipt_date: date, amount: 999999999, payment_type: 'inbound', currency: 'TZS' }] : [],
    delivery_details: [],
  };
}

async function clean() {
  await db.query("DELETE FROM odoo_sale_invoices WHERE invoice_date BETWEEN '2001-02-01' AND '2001-05-31'");
  await db.query("DELETE FROM odoo_sale_sync_days WHERE sync_day BETWEEN '2001-02-01' AND '2001-05-31'");
  await db.query('DELETE FROM odoo_sale_receipts WHERE receipt_id BETWEEN 910000000 AND 910000999');
}

let d;   // the March 2001 dashboard
test.before(async () => {
  await clean();
  const shared = 910000900;
  await storeDay('2001-03-10', [
    invoice({ date: '2001-03-10', code: 'CUS001', product: 'CEMENT 42.5 R', productCode: 'FG001',
      qty: 600, total: 10000000, residual: 0, receiptId: shared }),                   // 30 MT
    invoice({ date: '2001-03-10', code: 'CUS002', product: 'CEMENT B-M 42.5 N', productCode: 'FG005',
      qty: 640, total: 12000000, residual: 4000000, payment: 'partial', division: 'D2',
      zone: 'Zone B', receiptId: shared }),                                             // 32 MT
    invoice({ date: '2001-03-10', code: 'CUS003', product: 'FLY ASH', productCode: 'FA1',
      qty: 5, uom: 'MT', total: 500000, residual: 500000, payment: 'not_paid' }),       // non-cement
  ]);
  await storeDay('2001-03-11', []);        // synced, genuinely no invoices
  // 2001-03-12 never synced
  await storeDay('2001-02-05', [
    invoice({ date: '2001-02-05', code: 'CUS001', product: 'CEMENT 42.5 R', productCode: 'FG001',
      qty: 200, total: 3000000, residual: 0 }),
  ]);                                       // February: 1 of 28 days synced
  d = await sales.getDashboard(2001, 3);
});
test.after(clean);

test('getDashboard: invoiced basis, with honest coverage of a partly synced month', () => {
  assert.equal(d.tonnage_basis.basis, 'invoiced');
  assert.equal(d.tonnage_basis.coverage.days_synced, 2);
  assert.equal(d.tonnage_basis.coverage.days_expected, 31);
  assert.equal(d.tonnage_basis.coverage.complete, false);
});

test('getDashboard: cement only — the fly ash invoice is excluded, excise lines never counted', () => {
  assert.equal(d.mtd.actual_mt, 62);
  assert.equal(d.mtd.invoice_count, 2);
  assert.equal(d.mtd.active_customers, 2);
});

test('getDashboard: a synced empty day is 0, an unsynced day is null', () => {
  const day = k => d.daily_trend.find(t => t.date === k).actual;
  assert.equal(day('2001-03-10'), 62);
  assert.equal(day('2001-03-11'), 0);
  assert.equal(day('2001-03-12'), null);
  assert.equal(d.mtd.worst_day.mt, 0, 'a synced zero day is a legitimate worst day');
});

test('getDashboard: grade mix sums to the headline, keyed by product code', () => {
  const g = Object.fromEntries(d.grades.map(x => [x.key, x.mtd_actual_mt]));
  assert.equal(g.super42, 30);
  assert.equal(g.duramax42, 32);
  assert.equal(d.grades.reduce((s, x) => s + (x.mtd_actual_mt || 0), 0), d.mtd.actual_mt);
});

test('getDashboard: collections are invoiced − outstanding; the shared receipt is never summed', () => {
  assert.equal(d.collections.ok, true);
  assert.equal(d.collections.invoiced_tzs, 22000000);
  assert.equal(d.collections.outstanding_tzs, 4000000);
  assert.equal(d.collections.total_collected_tzs, 18000000);
  assert.equal(d.collections.collection_rate_pct, 81.8);
});

test('getDashboard: top customers and territory come from the same cement rows', () => {
  assert.deepEqual(d.top_customers.map(c => c.code), ['CUS002', 'CUS001']);
  const div = Object.fromEntries(d.territory.by_division.map(x => [x.division, x.mt]));
  assert.deepEqual(div, { D1: 30, D2: 32 });
  assert.equal(d.territory.by_division[0].drr, Math.round((30 / 31) * 10) / 10);
});

test('getDashboard: no month-on-month against a partly synced previous month', () => {
  assert.equal(d.mtd.prev_month_actual_mt, null);
  assert.equal(d.mtd.mom_delta_pct, null);
  assert.match(d.mtd.prev_month_note, /1 of 28 days synced/);
});

test('getDashboard: a month with no data reports null and honest statuses, never zeros', async () => {
  const empty = await sales.getDashboard(2001, 5);
  assert.equal(empty.tonnage_basis.basis, null);
  assert.equal(empty.mtd.actual_mt, null);
  assert.equal(empty.mtd.active_customers, null);
  assert.ok(empty.grades.every(g => g.mtd_actual_mt === null));
  assert.equal(empty.top_customers.length, 0);
  assert.equal(empty.collections.ok, false);
  assert.ok(['not_configured', 'not_synced'].includes(empty.collections.status));
  assert.ok(empty.daily_trend.every(t => t.actual === null));
});
