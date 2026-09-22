/*
  services/purchases.js — Purchase & Stores dashboard aggregation.

  Two sources, deliberately kept apart:
    • Purchase (PO trend / Open PR–PO category grid) is an Odoo
      read-through — see services/purchasesOdoo.js for the per-metric
      contract. The PO List section was removed 2026-09-22 at the
      business's request: the same list is read in Odoo itself, and
      shipping it twice meant a second place to keep correct.
    • Stores (inventory, stock levels, receipt-vs-issue, diesel by
      department) comes from the MIS's own `materials` daily report and
      needs no Odoo connection — see services/stores.js.

  Keeping both on one payload means the page shows real Stores numbers
  today even while every Purchase tile is still waiting on Odoo credentials.
*/
const purchasesOdoo = require('./purchasesOdoo');
const stores = require('./stores');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function _iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function _lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/* Turn the query string into one resolved period. Exported so
   routes/purchases.js stays a thin validator and so this is testable
   without a server or an Odoo connection.

   Four modes (2026-09-22 — the report used to offer month only):
     month    year + month          the original behaviour, still the default
     quarter  year + quarter 1-4
     ytd      year                  1 Jan to today, or to 31 Dec for a past year
     custom   from + to             any range, capped at 36 months upstream

   `year` is carried on the result because the PO trend chart is always a
   12-month view of one year regardless of the period chosen; for a custom
   range that is the year the range ENDS in, which is the one a reader is
   looking at. */
function resolvePeriod(q) {
  q = q || {};
  const now = new Date();
  const today = _iso(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const mode = q.mode || 'month';

  if (mode === 'custom') {
    /* Swap rather than reject a reversed range: the two inputs sit side by
       side on the page and transposing them is a slip, not a request for
       an error. */
    let from = q.from, to = q.to;
    if (from > to) { const t = from; from = to; to = t; }
    return {
      mode, from, to,
      year: Number(to.slice(0, 4)),
      month: null, quarter: null,
      label: _rangeLabel(from, to),
    };
  }

  const year = Number(q.year) || now.getUTCFullYear();

  if (mode === 'quarter') {
    const quarter = Number(q.quarter) || Math.floor(now.getUTCMonth() / 3) + 1;
    const firstMonth = (quarter - 1) * 3 + 1;
    const lastMonth = firstMonth + 2;
    return {
      mode, year, quarter, month: null,
      from: _iso(year, firstMonth, 1),
      to: _iso(year, lastMonth, _lastDay(year, lastMonth)),
      label: `Q${quarter} ${year} — ${MONTH_NAMES[firstMonth - 1].slice(0, 3)}–${MONTH_NAMES[lastMonth - 1].slice(0, 3)}`,
    };
  }

  if (mode === 'ytd') {
    /* A past year runs to 31 December; the current year stops at today,
       because asking Odoo for months that have not happened yet only buys
       a slower call and a row of zeroes. */
    const to = year === now.getUTCFullYear() ? today : _iso(year, 12, 31);
    const throughMonth = Number(to.slice(5, 7));
    return {
      mode, year, month: null, quarter: null,
      from: _iso(year, 1, 1), to,
      label: `${year} year to date — Jan–${MONTH_NAMES[throughMonth - 1].slice(0, 3)}`,
    };
  }

  const month = Number(q.month) || (now.getUTCMonth() + 1);
  return {
    mode: 'month', year, month, quarter: null,
    from: _iso(year, month, 1),
    to: _iso(year, month, _lastDay(year, month)),
    label: `${MONTH_NAMES[month - 1]} ${year}`,
  };
}

function _rangeLabel(from, to) {
  const d = iso => {
    const [y, m, day] = iso.split('-').map(Number);
    return { y, m, day };
  };
  const a = d(from), b = d(to);
  const day = x => `${x.day} ${MONTH_NAMES[x.m - 1].slice(0, 3)}`;
  if (a.y === b.y) return `${day(a)} – ${day(b)} ${b.y}`;
  return `${day(a)} ${a.y} – ${day(b)} ${b.y}`;
}

async function getDashboard(query) {
  const period = resolvePeriod(query);

  const [trend, categoryGrid, storesData] = await Promise.all([
    purchasesOdoo.fetchPoValueTrend(period.year),
    purchasesOdoo.fetchCategoryGrid(period.from, period.to),
    /* Stores reads Postgres, not Odoo — a failure here is a real error
       worth surfacing, not the "integration not wired yet" state the Odoo
       calls model, so it isn't given a never-throw wrapper.

       It is a MONTHLY report, so it is asked for the month the period ends
       in. A quarter or a year-to-date range shows that month's closing
       stock, which is what a closing figure means; the page labels it. */
    stores.getStoresDashboard(period.year, Number(period.to.slice(5, 7))),
  ]);

  return {
    period,
    po_value_trend: trend.ok
      ? { ok: true, months: trend.value, as_of: trend.as_of, source: trend.source }
      : { ok: false, status: trend.status, message: trend.message },
    category_grid: categoryGrid.ok
      ? { ok: true, ...categoryGrid.value, partial_months: categoryGrid.partial_months,
          as_of: categoryGrid.as_of, source: categoryGrid.source }
      : { ok: false, status: categoryGrid.status, message: categoryGrid.message },
    stores: storesData,
    sources: {
      po_value_trend: trend.ok ? trend.source : trend.status,
      category_grid: categoryGrid.ok ? categoryGrid.source : categoryGrid.status,
      stores: storesData.inventory.ok ? 'mis:materials' : storesData.inventory.status,
    },
  };
}

module.exports = { getDashboard, resolvePeriod };
