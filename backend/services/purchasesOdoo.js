/*
  services/purchasesOdoo.js — every Odoo-sourced number on the Purchase
  dashboard, one function per metric. Each function NEVER throws — it
  returns either
      { ok: true,  value, as_of, source }
  or  { ok: false, status: 'not_configured' | 'unreachable' | 'parse_error'
        | 'not_mapped', message: '<honest, user-facing reason>' }
  so routes/purchases.js can Promise.all them and the page renders each
  section's real state without one missing piece blanking the dashboard.

  ── 2026-09-03: rewritten onto the Odoo team's custom endpoint ──────────
  This used to issue model reads (purchase.order etc.) through the generic
  External API and infer classifications itself. The Odoo team instead
  delivered ONE aggregate endpoint per dashboard, so everything here now
  goes through services/odooDashboardClient.js and the classification
  guesswork is gone — the endpoint returns the real fields:

    - purchase_type: 'local' | 'import'   (replaces parsing LPORD/IPORD
      out of the PO name — that inference is retired)
    - po_for_key:    'material' | 'service'  (replaces inferring Service
      from product.type)
    - purchase_order_lines.pending_quantity, alongside quantity and
      received_quantity — this is what finally makes Open PO computable
      for SERVICE lines too, which was blocked for months on the
      unconfirmed "Qty Serviced" field name.
    - product_categories.classification carries the full category path,
      and "Raw Material" is confirmed present as a real category (it was
      previously an educated guess from RM-prefixed product codes).

  Still genuinely unavailable, so still per-cell not_mapped:
    - The entire Open PR row. The endpoint returns no PR/requisition data
      at all — no pr_no, no requisition record. Requested 2026-09-03.

  Caveat carried from the client: the endpoint's `products` and
  `product_categories` arrays are themselves date-filtered (a server-side
  defect), so they are NOT a full catalogue. Harmless here because we only
  use them to classify orders inside the same range — but do not reuse
  them as a product master anywhere else.
*/
const client = require('./odooDashboardClient');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function _notMapped(message) {
  return { ok: false, status: 'not_mapped', message };
}

/* Pass a failed bundle straight through — its status/message already say
   whether Odoo is unconfigured, unreachable, or truncated the response. */
function _fail(bundle) {
  return { ok: false, status: bundle.status, message: bundle.message };
}

function _monthRange(year, monthIndex) {
  const m = String(monthIndex + 1).padStart(2, '0');
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return [`${year}-${m}-01`, `${year}-${m}-${String(last).padStart(2, '0')}`];
}

/* PO value by month for a year.

   The endpoint has no pagination and truncates on large ranges, so a
   whole year in one call is impossible — this fetches month by month.
   Uncached that is ~5s per month, but the client caches closed months for
   12h, so in practice only the current month is re-fetched. Months run
   with limited concurrency to avoid hammering the test server, and a
   month that fails degrades to null (rendered as a gap) rather than zero,
   so a fetch failure can never read as "no purchases that month". */
async function fetchPoValueTrend(year) {
  if (!client.isConfigured()) {
    return { ok: false, status: 'not_configured', message: 'The Odoo dashboard API is not configured on this server yet.' };
  }

  const today = new Date().toISOString().slice(0, 10);
  const months = [];
  for (let i = 0; i < 12; i++) {
    const [from, to] = _monthRange(year, i);
    months.push({ i, from, to, label: MONTHS[i], future: from > today });
  }

  const results = new Array(12).fill(null);
  const queue = months.filter(m => !m.future);
  const CONCURRENCY = 3;

  async function worker() {
    for (;;) {
      const m = queue.shift();
      if (!m) return;
      const bundle = await client.fetchPurchaseBundle(m.from, m.to);
      if (!bundle.ok) { results[m.i] = { error: bundle.status }; continue; }
      const orders = bundle.data.purchase_orders || [];
      results[m.i] = {
        value_tzs: Math.round(orders.reduce((s, o) => s + (o.total_amount || 0), 0)),
        count: orders.length,
      };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const value = months.map(m => {
    const r = results[m.i];
    if (!r) return { label: m.label, value_tzs: null, count: null, status: m.future ? 'future' : 'unavailable' };
    if (r.error) return { label: m.label, value_tzs: null, count: null, status: r.error };
    return { label: m.label, value_tzs: r.value_tzs, count: r.count, status: 'ok' };
  });

  if (!value.some(v => v.status === 'ok')) {
    return { ok: false, status: 'unreachable', message: `No month of ${year} could be loaded from Odoo.` };
  }
  return { ok: true, value, as_of: new Date().toISOString(), source: 'odoo:purchase_dashboard_report' };
}

/* PO list for a period — one call, straight mapping. */
async function fetchPoList(from, to) {
  const bundle = await client.fetchPurchaseBundle(from, to);
  if (!bundle.ok) return _fail(bundle);

  const orders = (bundle.data.purchase_orders || []).map(o => ({
    name: o.purchase_order,
    vendor: o.vendor,
    date_order: o.order_date,
    amount_total: o.total_amount,
    currency: o.currency,
    state: o.status,
    approval_status: o.approval_status,
    purchase_type: o.purchase_type,
    po_for: o.po_for,
    incoming_status: o.incoming_status,
  }));

  return {
    ok: true,
    value: {
      count: orders.length,
      total_value_tzs: Math.round(orders.reduce((s, o) => s + (o.amount_total || 0), 0)),
      orders: orders.slice(0, 200), // the page renders a table, not the whole period
      truncated: orders.length > 200,
    },
    as_of: bundle.as_of,
    source: bundle.source,
  };
}

/* Open PR / Open PO by category (Service · Local · Import · Raw Material).

   Open PO is now real for every column INCLUDING Service: a line is open
   when pending_quantity > 0, which the endpoint computes for goods and
   service lines alike. The columns are deliberately NOT mutually
   exclusive — a Raw Material PO is also Local or Import — so these are
   four independent filters over the same orders, not a partition.

   Open PR stays not_mapped: the endpoint carries no requisition data. */
async function fetchCategoryGrid(from, to) {
  const bundle = await client.fetchPurchaseBundle(from, to);
  if (!bundle.ok) return _fail(bundle);

  const orders = bundle.data.purchase_orders || [];
  const lines = bundle.data.purchase_order_lines || [];
  const products = bundle.data.products || [];
  const categories = bundle.data.product_categories || [];

  // Raw Material is identified from the full category path the endpoint
  // supplies on product_categories.classification.
  const rawMaterialCategoryIds = new Set(
    categories.filter(c => /raw material/i.test(c.classification || c.category || ''))
      .map(c => c.category_id));
  const rawMaterialProductIds = new Set(
    products.filter(p => rawMaterialCategoryIds.has(p.category_id)).map(p => p.product_id));

  const orderById = new Map(orders.map(o => [o.purchase_order_id, o]));

  /* An order is "open" for a column when it has at least one still-pending
     line matching that column; its contribution is the value of those
     pending lines only, not the whole PO. */
  const openByOrder = new Map();
  for (const l of lines) {
    if (!(l.pending_quantity > 0)) continue;
    const o = orderById.get(l.purchase_order_id);
    if (!o) continue;
    if (!openByOrder.has(o.purchase_order_id)) {
      openByOrder.set(o.purchase_order_id, { order: o, value: 0, rawMaterial: false });
    }
    const entry = openByOrder.get(o.purchase_order_id);
    const qty = l.quantity || 0;
    const unitValue = qty > 0 ? (l.line_amount || 0) / qty : 0;
    entry.value += unitValue * l.pending_quantity;
    if (rawMaterialProductIds.has(l.product_id)) entry.rawMaterial = true;
  }

  const open = Array.from(openByOrder.values());
  const cell = (predicate) => {
    const matched = open.filter(predicate);
    return {
      ok: true,
      count: matched.length,
      value_tzs: Math.round(matched.reduce((s, e) => s + e.value, 0)),
    };
  };

  const prPending = _notMapped(
    'Purchase Requisition data is not included in the Odoo dashboard endpoint — ' +
    'no PR number or requisition record is returned. Requested from the Odoo team.');

  return {
    ok: true,
    value: {
      service:      { open_pr: prPending, open_po: cell(e => e.order.po_for_key === 'service') },
      local:        { open_pr: prPending, open_po: cell(e => e.order.purchase_type === 'local') },
      import:       { open_pr: prPending, open_po: cell(e => e.order.purchase_type === 'import') },
      raw_material: { open_pr: prPending, open_po: cell(e => e.rawMaterial) },
    },
    as_of: bundle.as_of,
    source: bundle.source,
  };
}

module.exports = { fetchPoValueTrend, fetchPoList, fetchCategoryGrid };
