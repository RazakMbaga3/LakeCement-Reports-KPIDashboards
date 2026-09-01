/*
  services/purchases.js — Purchase & Stores dashboard aggregation.

  Two sources, deliberately kept apart:
    • Purchase (PO trend / PO list / category grid) is an Odoo read-through
      — see services/purchasesOdoo.js for the per-metric contract.
    • Stores (inventory, stock levels, receipt-vs-issue, diesel by
      department) comes from the MIS's own `materials` daily report and
      needs no Odoo connection — see services/stores.js.

  Keeping both on one payload means the page shows real Stores numbers
  today even while every Purchase tile is still waiting on Odoo credentials.
*/
const purchasesOdoo = require('./purchasesOdoo');
const stores = require('./stores');

async function getDashboard(year, month) {
  const _now = new Date();
  const today = new Date(Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate()));
  year  = year  || today.getUTCFullYear();
  month = month || (today.getUTCMonth() + 1);

  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth  = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastOfMonth  = new Date(Date.UTC(year, month - 1, daysInMonth));
  const fmt = d => d.toISOString().slice(0, 10);

  const [trend, poList, categoryGrid, storesData] = await Promise.all([
    purchasesOdoo.fetchPoValueTrend(year),
    purchasesOdoo.fetchPoList(fmt(firstOfMonth), fmt(lastOfMonth)),
    purchasesOdoo.fetchCategoryGrid(fmt(firstOfMonth), fmt(lastOfMonth)),
    /* Stores reads Postgres, not Odoo — a failure here is a real error
       worth surfacing, not the "integration not wired yet" state the Odoo
       calls model, so it isn't given a never-throw wrapper. */
    stores.getStoresDashboard(year, month),
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
    stores: storesData,
    sources: {
      po_value_trend: trend.ok ? trend.source : trend.status,
      po_list: poList.ok ? poList.source : poList.status,
      stores: storesData.inventory.ok ? 'mis:materials' : storesData.inventory.status,
    },
  };
}

module.exports = { getDashboard };
