/*
  test/odoo-sales-sync.test.js — the Sale Register mirror (odooSalesSync.js).

  Pure tests pin the three traps the feed carries (excise lines, shared
  receipts, delivery partner) and the UoM rule. DB tests run storeDay()
  against real Postgres in a sandbox — year-2001 invoice dates and
  synthetic ids, cleaned up before and after — to pin the replace-a-day
  semantics: idempotent re-pulls, pruning of cancelled invoices, and the
  rule that an empty answer never wipes a day.
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const db     = require('../db');
const sync   = require('../services/odooSalesSync');

// Shapes copied from a real 2026-09-30 invoice (INV/2026/09/01992).
function invoice(over = {}) {
  return {
    invoice_id: 900000001, invoice_number: 'INV/TEST/0001', invoice_date: '2001-01-15',
    customer_id: 9070, customer: 'Gsm Tanzania Limited - Dodoma', customer_code: 'CUS928',
    sale_order_id: 96370, sale_order: 'SO/TEST/1', sale_order_ids: 'SO/TEST/1', sale_order_date: '2001-01-14',
    status: 'posted', payment_status: 'paid', salesperson_id: 1206, salesperson: 'AJIT RANJAN SINGH',
    division_id: 6, division: 'D3', zone_id: 28, zone: 'Dodoma', region_id: 1540, region: 'Dodoma',
    total_amount: 12426880, untaxed_amount: 10531254.24, tax_amount: 1895625.76, residual_amount: 0,
    collection_amount: 24000000, currency: 'TZS',
    quantity: 1280,   // = 640 bags + the excise line's 640: the double count
    invoice_lines: [
      { line_id: 900000101, product_id: 44704, product: 'CEMENT B-M 42.5 N', product_code: 'FG005',
        quantity: 640, uom_id: 26, uom: '50 KG BAG', rate: 15375.08, amount: 9840054.24, taxed_amount: 11611264 },
      { line_id: 900000102, product_id: false, product: '', product_code: '',
        quantity: 640, uom_id: false, uom: '', rate: 1080, amount: 691200, taxed_amount: 815616 },
    ],
    customer_receipts: [
      { receipt_id: 900000201, receipt_number: 'CRDBT/TEST/1', receipt_date: '2001-01-20',
        amount: 24000000, payment_type: 'inbound', currency: 'TZS' },
    ],
    delivery_details: [{
      delivery_id: 900000301, delivery_number: 'CM/DN/TEST/1', delivery_date: '2001-01-15 17:35:57',
      scheduled_date: '2001-01-14 15:11:19', delivery_status: 'done', origin: 'SO/TEST/1',
      customer_id: 11874, customer: 'DODOMA - delivery contact', source_location: 'Stock CM',
      destination_location: 'Customers', quantity: 32, delivered_quantity: 32,
      delivery_lines: [{ move_id: 900000401, product_id: 44704, product: 'CEMENT B-M 42.5 N',
        product_code: 'FG005', quantity: 32, delivered_quantity: 32, uom: 'MT' }],
    }],
    ...over,
  };
}

// ── pure ────────────────────────────────────────────────────────────

test('lineTonnes: MT as-is, NN KG BAG by weight, anything unrecognised is null (never guessed)', () => {
  assert.equal(sync.lineTonnes(32, 'MT'), 32);
  assert.equal(sync.lineTonnes(640, '50 KG BAG'), 32);
  assert.equal(sync.lineTonnes(100, '25 KG BAG'), 2.5);
  assert.equal(sync.lineTonnes(10, 'Big Bag'), null);
  assert.equal(sync.lineTonnes(10, ''), null);
});

test('isCementProduct: cement by name, the way the Register classifies; fly ash and scrap are not', () => {
  assert.equal(sync.isCementProduct('CEMENT 42.5 R'), true);
  assert.equal(sync.isCementProduct('CEMENT B-M 42.5 N'), true);
  assert.equal(sync.isCementProduct('FLY ASH'), false);
  assert.equal(sync.isCementProduct('SCRAP STEEL'), false);
});

test('mapInvoice: tonnage comes from product lines — the excise line and invoice.quantity are never counted', () => {
  const m = sync.mapInvoice(invoice());
  const col = name => m.invoice[['invoice_id', 'invoice_number', 'invoice_date', 'customer_id', 'customer_name',
    'customer_code', 'sale_order_id', 'sale_order', 'sale_order_ids', 'sale_order_date', 'status',
    'payment_status', 'salesperson_id', 'salesperson', 'division_id', 'division', 'zone_id', 'zone',
    'region_id', 'region', 'currency', 'untaxed_amount', 'tax_amount', 'total_amount', 'residual_amount',
    'cement_mt', 'non_cement_mt', 'excise_amount', 'is_cement'].indexOf(name)];
  assert.equal(col('cement_mt'), 32, '640 bags = 32 MT, not 1280 bags = 64 MT');
  assert.equal(col('excise_amount'), 691200);
  assert.equal(col('is_cement'), true);
  assert.deepEqual(m.lines.map(l => l[2]), ['product', 'charge']);
  assert.equal(m.lines[0][9], 'duramax42', 'FG005 maps to DURAMAX 42 by product code');
});

test('mapInvoice: customer is the INVOICE customer, never the delivery-address contact', () => {
  const m = sync.mapInvoice(invoice());
  assert.equal(m.invoice[5], 'CUS928');
  assert.equal(m.invoice[4], 'Gsm Tanzania Limited - Dodoma');
});

test('mapInvoice: collection_amount (the whole shared receipt) is not stored anywhere', () => {
  const m = sync.mapInvoice(invoice());
  assert.ok(!m.invoice.includes(24000000), 'collection_amount must not reach the invoice row');
  assert.equal(m.receipts.length, 1);
  assert.equal(m.receipts[0][3], 24000000, 'the receipt itself is stored once, by receipt_id');
});

test('mapInvoice: an unconvertible cement UoM is reported, not silently counted', () => {
  const inv = invoice();
  inv.invoice_lines[0].uom = '40 LB SACK';
  const m = sync.mapInvoice(inv);
  assert.equal(m.unknownUom.length, 1);
  assert.equal(m.invoice[25], 0, 'cement_mt excludes the line it could not convert');
});

test('mapInvoice: a NON-cement line in an odd unit is not reported (it affects no figure)', () => {
  const inv = invoice();
  inv.invoice_lines.push({ line_id: 900000109, product_id: 1, product: 'INSURANCE CLAIM PASSED',
    product_code: 'X', quantity: 1, uom: 'PCS', rate: 5, amount: 5, taxed_amount: 5 });
  const m = sync.mapInvoice(inv);
  assert.equal(m.unknownUom.length, 0);
  assert.equal(m.invoice[25], 32, 'cement tonnage unchanged');
});

test('mapInvoice: a row without id/number/date is rejected, not stored with nulls', () => {
  assert.equal(sync.mapInvoice(invoice({ invoice_date: null })).rejected, true);
  assert.equal(sync.mapInvoice(invoice({ invoice_id: null })).rejected, true);
});

// ── storeDay against Postgres (sandbox: 2001-01-15, ids 9000000xx) ──────

const DAY = '2001-01-15';
async function clean() {
  await db.query("DELETE FROM odoo_sale_invoices WHERE invoice_date BETWEEN '2001-01-01' AND '2001-12-31'");
  await db.query('DELETE FROM odoo_sale_receipts WHERE receipt_id BETWEEN 900000000 AND 900000999');
  await db.query("DELETE FROM odoo_sale_sync_days WHERE sync_day BETWEEN '2001-01-01' AND '2001-12-31'");
}
test.before(clean);
test.after(async () => { await clean(); });

const count = async (sql, p) => Number((await db.query(sql, p)).rows[0].c);

test('storeDay: stores every table, and a re-pull of the same day is idempotent', async () => {
  const two = [invoice(), invoice({
    invoice_id: 900000002, invoice_number: 'INV/TEST/0002',
    invoice_lines: [{ line_id: 900000103, product_id: 57, product: 'CEMENT 42.5 R', product_code: 'FG001',
      quantity: 600, uom: '50 KG BAG', rate: 1, amount: 1, taxed_amount: 1 }],
    delivery_details: [],
  })];
  for (let i = 0; i < 2; i++) {
    const r = await sync.storeDay(DAY, two);
    assert.equal(r.stored, 2);
    assert.equal(r.cementMt, 62);
  }
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_invoices WHERE invoice_date = $1', [DAY]), 2);
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_invoice_lines WHERE invoice_id IN (900000001,900000002)'), 3);
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_delivery_lines WHERE invoice_id = 900000001'), 1);
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_invoice_receipts WHERE invoice_id = 900000001'), 1);
});

test('storeDay: an invoice Odoo stops returning for that day is pruned (cancelled/reversed)', async () => {
  const r = await sync.storeDay(DAY, [invoice()]);
  assert.equal(r.pruned, 1);
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_invoices WHERE invoice_date = $1', [DAY]), 1);
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_invoice_lines WHERE invoice_id = 900000002'), 0,
    'its lines go with it');
});

test('storeDay: an EMPTY answer never wipes a day we hold invoices for', async () => {
  const r = await sync.storeDay(DAY, []);
  assert.equal(r.pruneSkipped, true);
  assert.equal(r.pruned, 0);
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_invoices WHERE invoice_date = $1', [DAY]), 1);
});

test('storeDay: payment status and residual are updated in place on a re-pull', async () => {
  await sync.storeDay(DAY, [invoice({ payment_status: 'not_paid', residual_amount: 12426880 })]);
  const row = (await db.query('SELECT payment_status, residual_amount FROM odoo_sale_invoices WHERE invoice_id = 900000001')).rows[0];
  assert.equal(row.payment_status, 'not_paid');
  assert.equal(Number(row.residual_amount), 12426880);
});

test('storeDay: a receipt shared by two invoices is stored once and linked twice', async () => {
  const shared = invoice().customer_receipts;
  await sync.storeDay(DAY, [invoice(), invoice({
    invoice_id: 900000003, invoice_number: 'INV/TEST/0003', customer_receipts: shared,
    invoice_lines: [], delivery_details: [],
  })]);
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_receipts WHERE receipt_id = 900000201'), 1);
  assert.equal(await count('SELECT count(*) c FROM odoo_sale_invoice_receipts WHERE receipt_id = 900000201'), 2);
});

test('storeDay: marks the day synced, counting what the table holds (so a skipped prune is not under-counted)', async () => {
  await sync.storeDay('2001-01-16', []);
  const empty = (await db.query("SELECT invoices FROM odoo_sale_sync_days WHERE sync_day = '2001-01-16'")).rows[0];
  assert.equal(empty.invoices, 0, 'a genuinely empty day is recorded as synced with 0 invoices');
  const held = (await db.query('SELECT invoices FROM odoo_sale_sync_days WHERE sync_day = $1', [DAY])).rows[0];
  assert.ok(held.invoices >= 1);
});
