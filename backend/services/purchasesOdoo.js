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

  The Service/Local/Import/Raw Material category grid is PARTIALLY
  mapped, cell by cell (2026-08-24 screenshots of the live Purchase app
  settled some of this without needing custom field names at all):
    - Local vs Import: purchase.order.name prefix — LPORD/2026/00747
      vs IPORD/2026/00051, seen side by side on real records. No custom
      field needed.
    - Service vs Goods: product.product's own standard `type` field
      ('service' vs everything else) — confirmed by the live "Storable
      Product (13952) / Service (68)" product grouping, matches stock
      Odoo exactly.
    - Raw Material: assumed to be product.categ_id containing "Raw
      Material" (matches the RM-prefixed product codes seen, e.g.
      RM000003 GYPSUM) — plausible but not directly confirmed; the
      grouped Products view was cut off alphabetically before reaching
      it. Low risk, easy to correct if wrong (one regex).
  Still genuinely blocked, left as per-cell not_mapped:
    - The entire Open PR row — unresolved whether "PR No" (LPR/2026/xxxx,
      seen per PO line) is a separate Purchase Requisition object or
      just a reference number (2026-08-10: "not sure, need to check").
    - Open PO for Service-type lines — needs the "Qty Serviced"/
      "Pending Qty" custom field names seen on service PO lines, not
      confirmed. Local/Import Open PO counts also exclude any PO that
      has a service line on it, for the same reason — excluded rather
      than guessed.
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

/* Service / Local / Import / Raw Material x Open PR / Open PO grid — see
   the file header for which cells are real vs per-cell not_mapped.
   Returns ok:true (when Odoo is reachable) with a per-cell {ok,...}
   shape even though some cells are still pending — only a hard
   not_configured/unreachable blanks the whole grid, same as every
   other metric in this file. */
async function fetchCategoryGrid(from, to) {
  if (!_configured()) return _notConfigured();
  return _cached(`categoryGrid|${from}|${to}`, async () => {
    try {
      const orders = await odoo.searchRead('purchase.order',
        [['date_order', '>=', from], ['date_order', '<=', to], ['state', '!=', 'cancel']],
        ['id', 'name', 'amount_total']);

      const orderIds = orders.map(o => o.id);
      const lines = orderIds.length
        ? await odoo.searchRead('purchase.order.line',
            [['order_id', 'in', orderIds]],
            ['order_id', 'product_id', 'product_qty', 'qty_received', 'price_subtotal'])
        : [];

      const productIds = [...new Set(lines
        .map(l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id)
        .filter(Boolean))];
      const products = productIds.length
        ? await odoo.searchRead('product.product', [['id', 'in', productIds]], ['type', 'categ_id'])
        : [];
      const productById = new Map(products.map(p => [p.id, p]));

      const linesByOrder = new Map();
      for (const l of lines) {
        const oid = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
        if (!linesByOrder.has(oid)) linesByOrder.set(oid, []);
        linesByOrder.get(oid).push(l);
      }
      const isServiceLine = l => productById.get(Array.isArray(l.product_id) ? l.product_id[0] : l.product_id)?.type === 'service';
      const isOpenLine = l => (l.qty_received || 0) < (l.product_qty || 0);

      /* Local / Import — PO-header granularity via the name prefix. A PO
         only counts toward "open" if every line on it is a goods line we
         can actually assess receipt progress for; one with any service
         line is excluded rather than guessed at (see servicePoPending). */
      const byPrefix = { local: { count: 0, value_tzs: 0 }, import: { count: 0, value_tzs: 0 } };
      for (const o of orders) {
        const key = o.name.startsWith('IPORD') ? 'import' : o.name.startsWith('LPORD') ? 'local' : null;
        if (!key) continue;
        const oLines = linesByOrder.get(o.id) || [];
        if (!oLines.length || oLines.some(isServiceLine)) continue;
        if (oLines.some(isOpenLine)) {
          byPrefix[key].count += 1;
          byPrefix[key].value_tzs += o.amount_total || 0;
        }
      }

      /* Raw Material — line granularity via product.categ_id path. */
      const rawMaterial = { count: 0, value_tzs: 0 };
      for (const l of lines) {
        const product = productById.get(Array.isArray(l.product_id) ? l.product_id[0] : l.product_id);
        const categPath = product && Array.isArray(product.categ_id) ? product.categ_id[1] : '';
        if (!/raw material/i.test(categPath || '')) continue;
        if (isOpenLine(l)) {
          rawMaterial.count += 1;
          rawMaterial.value_tzs += l.price_subtotal || 0;
        }
      }

      const okCell = c => ({ ok: true, count: c.count, value_tzs: Math.round(c.value_tzs) });
      const prPending = _notMapped('Open PR pending: unresolved whether "PR No" (LPR/2026/...) is a ' +
        'separate Purchase Requisition object or just a reference number on the PO.');
      const servicePoPending = _notMapped('Needs the "Qty Serviced" / "Pending Qty" technical field names ' +
        'for service lines — not yet confirmed.');

      const value = {
        service:      { open_pr: prPending, open_po: servicePoPending },
        local:        { open_pr: prPending, open_po: okCell(byPrefix.local) },
        import:       { open_pr: prPending, open_po: okCell(byPrefix.import) },
        raw_material: { open_pr: prPending, open_po: okCell(rawMaterial) },
      };

      return { ok: true, value, as_of: new Date().toISOString(), source: 'odoo:purchase.order+purchase.order.line' };
    } catch (err) { return _unreachable(err); }
  });
}

module.exports = { fetchPoValueTrend, fetchPoList, fetchCategoryGrid };
