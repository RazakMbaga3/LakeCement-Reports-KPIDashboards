/*
  test/sales-aggregation.test.js — the new Sales dashboard aggregation
  added for Avg Daily Sales/Best-Worst Day, Active/Top Customers, Avg Order
  Size/DSO-lite, and the Grade Mix Trend chart (see sales.js/salesOdoo.js).

  Covers:
    - services/sales.js: _buildGradeMixByDay, _buildTopCustomers (pure,
      exported alongside the existing _buildGradeMix/_matchGrade)
    - services/salesOdoo.js: fetchMtdSales's active_customers count,
      fetchCollections's dso_lite_days approximation — fetch is stubbed,
      same pattern as test/dashboard-cache.test.js

  Every case pins the honest-degradation rule from the task: Odoo
  unreachable -> null/[], a day or order with genuinely zero volume -> a
  real 0, never fabricated.

  No database.
  Usage: node --test test/sales-aggregation.test.js   (from backend/)
*/
process.env.ODOO_DASHBOARD_URL     = 'https://odoo.invalid';
process.env.ODOO_DASHBOARD_API_KEY = 'test-key';

const test   = require('node:test');
const assert = require('node:assert/strict');

const sales     = require('../services/sales');
const salesOdoo = require('../services/salesOdoo');

// ── fixtures: Odoo-RPC shapes as re-shaped by salesOdoo._shapeOrdersAndLines ──
const order = (id, date, partnerId, partnerName, amount = 1000) => ({
  id, date_order: date, partner_id: [partnerId, partnerName], amount_total: amount, state: 'sale',
});
const line = (orderId, productId, productName, qty, uomName = 'MT') => ({
  order_id: [orderId, 'SO' + orderId],
  product_id: [productId, productName],
  product_uom_qty: qty,
  product_uom: [1, uomName],
});

const SUPER42  = '[FG001] CEMENT 42.5 R';
const MAX32    = '[FG002] CEMENT 32.5';
const DURAMAX  = '[FG005] CEMENT B-M 42.5 N';
const UNKNOWN  = '[XX999] SCRAP METAL';

// ── services/sales.js pure helpers ──────────────────────────────────────

test('_matchGrade pins known product codes (regression for the 42.5 overcount bug)', () => {
  assert.equal(sales._matchGrade(SUPER42), 'super42');
  assert.equal(sales._matchGrade(MAX32), 'max32');
  assert.equal(sales._matchGrade(DURAMAX), 'duramax42');
  assert.equal(sales._matchGrade(UNKNOWN), null);
});

test('_buildGradeMixByDay returns [] when Odoo did not answer, not a fabricated series', () => {
  assert.deepEqual(sales._buildGradeMixByDay({ ok: false, status: 'unreachable' }), []);
});

test('_buildGradeMixByDay buckets lines by order date and grade, unmatched lines fold into "unmatched"', () => {
  const mtdSales = {
    ok: true,
    value: {
      orders: [
        order(1, '2026-10-01', 10, 'Acme Ltd'),
        order(2, '2026-10-01', 11, 'Beta Co'),
        order(3, '2026-10-02', 10, 'Acme Ltd'),
      ],
      lines: [
        line(1, 100, SUPER42, 50),
        line(2, 101, MAX32, 20),
        line(3, 100, SUPER42, 30),
        line(3, 999, UNKNOWN, 40),
      ],
    },
  };
  const trend = sales._buildGradeMixByDay(mtdSales);
  assert.equal(trend.length, 2, 'two distinct order dates');

  const day1 = trend.find(r => r.date === '2026-10-01');
  const day2 = trend.find(r => r.date === '2026-10-02');
  assert.equal(day1.super42, 50);
  assert.equal(day1.max32, 20);
  assert.equal(day1.duramax42, 0);
  assert.equal(day1.unmatched, undefined, 'no unmatched volume on day 1 -> key omitted');

  assert.equal(day2.super42, 30);
  assert.equal(day2.unmatched, 40, 'the scrap-metal line folds into unmatched, not dropped');
});

test('_buildGradeMixByDay converts bag UoM lines (20 bags = 1 MT), same rule as _buildGradeMix', () => {
  const mtdSales = {
    ok: true,
    value: {
      orders: [order(1, '2026-10-05', 10, 'Acme Ltd')],
      lines: [line(1, 100, SUPER42, 200, 'Bags')], // 200 bags -> 10 MT
    },
  };
  const trend = sales._buildGradeMixByDay(mtdSales);
  assert.equal(trend[0].super42, 10);
});

test('_buildGradeMixByDay drops lines whose order date cannot be resolved, never crashes', () => {
  const mtdSales = {
    ok: true,
    value: {
      orders: [order(1, '2026-10-01', 10, 'Acme Ltd')],
      lines: [line(2, 100, SUPER42, 50)], // order_id 2 has no matching order
    },
  };
  assert.deepEqual(sales._buildGradeMixByDay(mtdSales), []);
});

test('_buildTopCustomers returns [] when Odoo did not answer', () => {
  assert.deepEqual(sales._buildTopCustomers({ ok: false, status: 'not_configured' }), []);
});

test('_buildTopCustomers sums MT per customer across multiple orders/lines and sorts desc', () => {
  const mtdSales = {
    ok: true,
    value: {
      orders: [
        order(1, '2026-10-01', 10, 'Acme Ltd'),
        order(2, '2026-10-02', 10, 'Acme Ltd'),   // same customer, second order
        order(3, '2026-10-01', 11, 'Beta Co'),
      ],
      lines: [
        line(1, 100, SUPER42, 50),
        line(2, 101, MAX32, 20),
        line(3, 100, SUPER42, 200),               // Beta Co: biggest single line
      ],
    },
  };
  const top = sales._buildTopCustomers(mtdSales);
  assert.equal(top.length, 2);
  assert.equal(top[0].name, 'Beta Co');
  assert.equal(top[0].mt, 200);
  assert.equal(top[1].name, 'Acme Ltd');
  assert.equal(top[1].mt, 70, 'Acme Ltd aggregated across both its orders: 50 + 20');
});

test('_buildTopCustomers caps at 10 customers', () => {
  const orders = []; const lines = [];
  for (let i = 0; i < 15; i++) {
    orders.push(order(i, '2026-10-01', i, 'Customer ' + i, 1000));
    lines.push(line(i, 100, SUPER42, 15 - i)); // descending MT so the order is deterministic
  }
  const top = sales._buildTopCustomers({ ok: true, value: { orders, lines } });
  assert.equal(top.length, 10);
  assert.equal(top[0].name, 'Customer 0');
});

// ── services/salesOdoo.js after the 2026-10-08 sales-feed reshape ───────
//
// Odoo replaced sale_dashboard_report's payload; the arrays these functions
// parsed no longer exist and, defaulted to [], read as ZERO. They now stop
// calling Odoo and degrade honestly. These pin both halves: no fabricated
// zero reaches the dashboard, and no request reaches the production ERP.

const OLD_FEED_READERS = [
  ['fetchMtdSales',           () => salesOdoo.fetchMtdSales('2026-10-01', '2026-10-08')],
  ['fetchCollections',        () => salesOdoo.fetchCollections('2026-10-01', '2026-10-08', 8)],
  ['fetchAgewiseOutstanding', () => salesOdoo.fetchAgewiseOutstanding('2026-10-01', '2026-10-08')],
  ['fetchOfficerAchievement', () => salesOdoo.fetchOfficerAchievement('2026-10-01', '2026-10-08')],
];

// Each case pins its own Odoo env so the result doesn't depend on whether
// the machine running it has a .env (CI has none).
async function withOdooEnv(configured, fn) {
  const saved = { url: process.env.ODOO_DASHBOARD_URL, key: process.env.ODOO_DASHBOARD_API_KEY };
  const realFetch = global.fetch;
  if (configured) { process.env.ODOO_DASHBOARD_URL = 'https://odoo.invalid'; process.env.ODOO_DASHBOARD_API_KEY = 'k'; }
  else { delete process.env.ODOO_DASHBOARD_URL; delete process.env.ODOO_DASHBOARD_API_KEY; }
  const seen = { requests: 0 };
  global.fetch = async () => { seen.requests++; throw new Error('must not be called'); };
  try { return await fn(seen); }
  finally {
    global.fetch = realFetch;
    for (const [k, v] of [['ODOO_DASHBOARD_URL', saved.url], ['ODOO_DASHBOARD_API_KEY', saved.key]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

for (const [name, call] of OLD_FEED_READERS) {
  test(`${name}: reports format_changed (never a zero-filled ok:true) and makes no Odoo request`, () =>
    withOdooEnv(true, async (seen) => {
      const r = await call();
      assert.equal(r.ok, false);
      assert.equal(r.status, 'format_changed');
      assert.match(r.message, /changed the sales feed format/);
      assert.equal(seen.requests, 0, 'the reshaped endpoint must not be called on a page load');
    }));

  test(`${name}: still reports not_configured when Odoo is not set up`, () =>
    withOdooEnv(false, async (seen) => {
      const r = await call();
      assert.equal(r.ok, false);
      assert.equal(r.status, 'not_configured');
      assert.equal(seen.requests, 0);
    }));
}
