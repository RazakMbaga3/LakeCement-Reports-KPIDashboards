/*
  services/salesOdoo.js — every Odoo-sourced number on the Sales dashboard,
  one function per metric.

  Contract: NEVER throws. Each function returns either
      { ok: true,  value, as_of, source: 'odoo:<model>' }
  or  { ok: false, status: 'not_configured' | 'unreachable' | 'not_mapped',
        message: '<honest, user-facing reason>' }
  so routes/sales.js can Promise.all them and the page renders each tile's
  real state without one missing integration blanking the whole dashboard.

  'not_mapped' is first-class, not an error: it means we know the metric
  is wanted and no Odoo model has been identified for it yet. Wiring one
  up later = replace that one function's body — nothing else moves.

  Live pull-on-request with a short TTL cache, not cron+cache — see the
  Sales Dashboard plan for reasoning (these are point-in-time balances,
  not day-stamped facts like the dispatch pull).
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

/* Sum sale.order.line quantities to metric tonnes — ported from the
   standalone sales app's odoo_client.py (lines_to_qty_mt): lines already
   in a MT/tonne UoM are summed directly, everything else is assumed to
   be 50kg bags (20 bags = 1 MT), same convention used elsewhere in this
   app's Odoo integrations. */
function _linesToQtyMt(lines) {
  let total = 0;
  for (const line of lines) {
    const uom = line.product_uom;
    const uomName = (Array.isArray(uom) ? uom[1] : uom) || '';
    const qty = line.product_uom_qty || 0;
    if (/MT|TON|TONNE/i.test(uomName)) total += qty;
    else total += qty / 20;
  }
  return total;
}

/* GET MTD/on-date sales volume — sale.order, proven query shape from the
   standalone sales app's dashboard.py (dashboard_overview -> live_odoo). */
async function fetchMtdSales(from, to) {
  if (!_configured()) return _notConfigured();
  return _cached(`mtdSales|${from}|${to}`, async () => {
    try {
      const orders = await odoo.searchRead('sale.order',
        [['date_order', '>=', from], ['date_order', '<=', to], ['state', 'in', ['sale', 'done']]],
        ['id', 'name', 'date_order', 'partner_id', 'amount_total', 'user_id']);
      const orderIds = orders.map(o => o.id);
      const lines = orderIds.length
        ? await odoo.searchRead('sale.order.line',
            [['order_id', 'in', orderIds], ['display_type', '=', false]],
            ['order_id', 'product_id', 'product_uom_qty', 'product_uom'])
        : [];
      return {
        ok: true,
        value: {
          order_count: orders.length,
          qty_mt: Math.round(_linesToQtyMt(lines) * 10) / 10,
          value_tzs: Math.round(orders.reduce((s, o) => s + (o.amount_total || 0), 0)),
          orders, lines, // handed to services/sales.js for territory/officer attribution
        },
        as_of: new Date().toISOString(),
        source: 'odoo:sale.order',
      };
    } catch (err) { return _unreachable(err); }
  });
}

/* GET collections/outstanding — account.move, proven query shape from the
   standalone sales app (odoo_sync.py invoice_summary). No aging buckets,
   no advances, no payables — confirmed genuinely absent there too. */
async function fetchCollections(from, to) {
  if (!_configured()) return _notConfigured();
  return _cached(`collections|${from}|${to}`, async () => {
    try {
      const invoices = await odoo.searchRead('account.move',
        [['invoice_date', '>=', from], ['invoice_date', '<=', to],
         ['move_type', '=', 'out_invoice'], ['state', '=', 'posted']],
        ['id', 'name', 'invoice_date', 'partner_id', 'amount_total', 'amount_residual', 'payment_state']);
      const totalInvoiced = invoices.reduce((s, i) => s + (i.amount_total || 0), 0);
      const totalOutstanding = invoices.reduce((s, i) => s + (i.amount_residual || 0), 0);
      const totalCollected = totalInvoiced - totalOutstanding;
      return {
        ok: true,
        value: {
          invoice_count: invoices.length,
          total_invoiced_tzs: Math.round(totalInvoiced),
          total_collected_tzs: Math.round(totalCollected),
          outstanding_tzs: Math.round(totalOutstanding),
          collection_rate_pct: totalInvoiced ? Math.round((totalCollected / totalInvoiced) * 1000) / 10 : 0,
        },
        as_of: new Date().toISOString(),
        source: 'odoo:account.move',
      };
    } catch (err) { return _unreachable(err); }
  });
}

/* Aged Receivable — bucketed from account.move, matching the exact
   structure of Odoo's own "Aged Receivable" report seen live 2026-08-24
   (Reporting > Sale and Dispatch): 0-30 / 31-60 / 61-90 / 91-120 / Older,
   by days overdue on the due date. Only outstanding (amount_residual > 0)
   posted customer invoices count — same fields fetchCollections already
   uses, just bucketed instead of summed flat. */
async function fetchAgewiseOutstanding() {
  if (!_configured()) return _notConfigured();
  return _cached('agewiseOutstanding', async () => {
    try {
      const invoices = await odoo.searchRead('account.move',
        [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['amount_residual', '>', 0]],
        ['id', 'invoice_date_due', 'invoice_date', 'amount_residual']);

      const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d91_120: 0, older: 0 };
      const today = Date.now();
      for (const inv of invoices) {
        const dueDate = inv.invoice_date_due || inv.invoice_date;
        const daysOverdue = dueDate ? Math.floor((today - new Date(dueDate).getTime()) / 86400000) : 0;
        const amt = inv.amount_residual || 0;
        if (daysOverdue <= 30) buckets.d0_30 += amt;
        else if (daysOverdue <= 60) buckets.d31_60 += amt;
        else if (daysOverdue <= 90) buckets.d61_90 += amt;
        else if (daysOverdue <= 120) buckets.d91_120 += amt;
        else buckets.older += amt;
      }
      Object.keys(buckets).forEach(k => { buckets[k] = Math.round(buckets[k]); });
      const total_tzs = Object.values(buckets).reduce((s, v) => s + v, 0);

      return {
        ok: true,
        value: { ...buckets, total_tzs, invoice_count: invoices.length },
        as_of: new Date().toISOString(),
        source: 'odoo:account.move',
      };
    } catch (err) { return _unreachable(err); }
  });
}

/* ── Still unmapped — real leads found 2026-08-24, but not enough to
   safely wire up yet (see project-sales-dashboard-phase2 memory). ─── */
async function fetchReceivedUncollectable() {
  return _notMapped('No Odoo model identified yet for Received Uncollectable.');
}
async function fetchPayable() {
  return _notMapped('Odoo has an "Aged Payable" report (Reporting > Sale and Dispatch) that could ' +
    'bucket account.move vendor bills the same way fetchAgewiseOutstanding does for receivables — ' +
    'but vendor payables arguably belong on the Purchase dashboard, not Sales. Needs a placement ' +
    'decision before wiring this up.');
}
async function fetchAdvance() {
  return _notMapped('Likely sourced from account.payment ("Customer Receipts", confirmed live ' +
    '2026-08-24) filtered to unreconciled inbound customer payments — but the exact reconciliation ' +
    'field/state values need confirming against the live database before this can be trusted.');
}
async function fetchOdooTargets(_month) {
  return _notMapped('No Odoo model identified yet for Sales Targets — using manual interim targets.');
}

module.exports = {
  fetchMtdSales, fetchCollections,
  fetchReceivedUncollectable, fetchPayable, fetchAdvance, fetchAgewiseOutstanding,
  fetchOdooTargets,
};
