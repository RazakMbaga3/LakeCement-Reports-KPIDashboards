/*
  services/purchases.js — Purchase dashboard aggregation.

  Unlike Sales, nothing here is manually entered — the whole dashboard is
  an Odoo read-through (see services/purchasesOdoo.js for the per-metric
  contract). This file just picks the date range for the requested
  month/year and shapes the payload for routes/purchases.js.
*/
const purchasesOdoo = require('./purchasesOdoo');

async function getDashboard(year, month) {
  const _now = new Date();
  const today = new Date(Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate()));
  year  = year  || today.getUTCFullYear();
  month = month || (today.getUTCMonth() + 1);

  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth  = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastOfMonth  = new Date(Date.UTC(year, month - 1, daysInMonth));
  const fmt = d => d.toISOString().slice(0, 10);

  const [trend, poList, categoryGrid] = await Promise.all([
    purchasesOdoo.fetchPoValueTrend(year),
    purchasesOdoo.fetchPoList(fmt(firstOfMonth), fmt(lastOfMonth)),
    purchasesOdoo.fetchCategoryGrid(fmt(firstOfMonth), fmt(lastOfMonth)),
  ]);

  return {
    period: {
      year, month,
      label: firstOfMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    },
    po_value_trend: trend.ok
      ? { ok: true, months: trend.value, as_of: trend.as_of, source: trend.source }
      : { ok: false, status: trend.status, message: trend.message },
    po_list: poList.ok
      ? { ok: true, ...poList.value, as_of: poList.as_of, source: poList.source }
      : { ok: false, status: poList.status, message: poList.message },
    category_grid: categoryGrid.ok
      ? { ok: true, ...categoryGrid.value, as_of: categoryGrid.as_of, source: categoryGrid.source }
      : { ok: false, status: categoryGrid.status, message: categoryGrid.message },
    sources: {
      po_value_trend: trend.ok ? trend.source : trend.status,
      po_list: poList.ok ? poList.source : poList.status,
    },
  };
}

module.exports = { getDashboard };
