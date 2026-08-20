/*
  services/purchasesOdoo.js — every Odoo-sourced number on the Purchase
  dashboard, one function per metric. Same contract as services/salesOdoo.js:
  each function NEVER throws — it returns either
      { ok: true,  value, as_of, source: 'odoo:<model>' }
  or  { ok: false, status: 'not_configured' | 'unreachable' | 'not_mapped',
        message: '<honest, user-facing reason>' }
  so routes/purchases.js can Promise.all them and the page renders each
  section's real state without one missing piece blanking the dashboard.

  PO Value trend and PO List use only fields guaranteed present on any
  Odoo purchase.order (date_order, amount_total, state, partner_id, name)
  — safe to ship without ever having queried the live database.

  The Service/Local/Import/Raw Material category grid depends on two
  custom fields (the purchase team's screenshots show them labelled
  "PO For" and "Purchase Type" on the form, but not their technical
  names) plus an unresolved question of whether "PR No" refers to a real
  Purchase Requisition object or just a reference number on the PO
  itself (2026-08-10: purchase team said "not sure, need to check").
  Rather than guess field names that would silently break once Odoo is
  configured, fetchCategoryGrid() stays a single honest not_mapped stub
  until both are confirmed — see docs/purchase dashboard notes.
*/
const odoo = require('./odooClient');

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // 'metric|from|to' -> { at, result }

function _cached(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.result);
  return fn().then(result => {
    _cache.set(key, { at: Date.now(), result });
    return result;
  });
}

function _configured() {
  return !!process.env.ODOO_URL;
}

function _notConfigured() {
  return { ok: false, status: 'not_configured', message: 'Odoo is not configured on this server yet.' };
}

function _unreachable(err) {
  return { ok: false, status: 'unreachable', message: 'Odoo did not respond: ' + (err && err.message || 'unknown error') };
}

function _notMapped(message) {
  return { ok: false, status: 'not_mapped', message };
}

const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* Total PO value by month for a calendar year — confirmed POs only
   (state in purchase/done), same "exclude drafts and cancellations"
   convention salesOdoo.fetchMtdSales uses for sale.order. */
async function fetchPoValueTrend(year) {
  if (!_configured()) return _notConfigured();
  return _cached(`poValueTrend|${year}`, async () => {
    try {
      const from = `${year}-01-01`, to = `${year}-12-31`;
      const orders = await odoo.searchRead('purchase.order',
        [['date_order', '>=', from], ['date_order', '<=', to], ['state', 'in', ['purchase', 'done']]],
        ['id', 'date_order', 'amount_total']);

      const byMonth = _MONTHS.map((label, i) => ({ month: i + 1, label, count: 0, value_tzs: 0 }));
      for (const o of orders) {
        const m = new Date(o.date_order).getUTCMonth();
        byMonth[m].count += 1;
        byMonth[m].value_tzs += o.amount_total || 0;
      }
      byMonth.forEach(b => { b.value_tzs = Math.round(b.value_tzs); });

      return { ok: true, value: byMonth, as_of: new Date().toISOString(), source: 'odoo:purchase.order' };
    } catch (err) { return _unreachable(err); }
  });
}

/* Browsable PO list for a period — every non-cancelled PO regardless of
   approval stage, so RFQs-in-progress are visible alongside confirmed
   orders (the category/PR-vs-PO split is a separate, still-unmapped cut
   — see fetchCategoryGrid). */
async function fetchPoList(from, to) {
  if (!_configured()) return _notConfigured();
  return _cached(`poList|${from}|${to}`, async () => {
    try {
      const orders = await odoo.searchRead('purchase.order',
        [['date_order', '>=', from], ['date_order', '<=', to], ['state', '!=', 'cancel']],
        ['id', 'name', 'date_order', 'partner_id', 'amount_total', 'state'],
        { order: 'date_order desc' });

      return {
        ok: true,
        value: {
          count: orders.length,
          total_value_tzs: Math.round(orders.reduce((s, o) => s + (o.amount_total || 0), 0)),
          orders: orders.map(o => ({
            id: o.id, name: o.name, date_order: o.date_order,
            vendor: Array.isArray(o.partner_id) ? o.partner_id[1] : null,
            amount_total: o.amount_total, state: o.state,
          })),
        },
        as_of: new Date().toISOString(),
        source: 'odoo:purchase.order',
      };
    } catch (err) { return _unreachable(err); }
  });
}

/* Service / Local / Import / Raw Material x Open PR / Open PO grid —
   not mapped yet. Two independent unknowns block this, either of which
   invalidates a guessed implementation rather than just leaving a gap:
     1. The Odoo technical field names behind the "PO For" and
        "Purchase Type" labels seen on the PO form (custom fields —
        not part of stock Odoo, no safe default to assume).
     2. Whether "PR No" (shown per PO line, e.g. LPR/2026/0206) is a
        real Purchase Requisition record with its own state, or just a
        reference number stamped onto the PO — changes what "Open PR"
        even queries.
   Once both are confirmed, replace this one function's body — nothing
   else (routes/services/purchases.js, purchases.html) needs to change,
   same pattern salesOdoo.js's not_mapped stubs use. */
async function fetchCategoryGrid() {
  return _notMapped(
    'Category breakdown pending: need the Odoo technical field names for ' +
    '"PO For" / "Purchase Type", and confirmation from the Odoo admin on ' +
    'whether "PR No" is a separate Purchase Requisition record or just a ' +
    'reference number on the PO.'
  );
}

module.exports = { fetchPoValueTrend, fetchPoList, fetchCategoryGrid };
