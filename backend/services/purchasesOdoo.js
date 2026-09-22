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

/* ── Arbitrary date ranges ─────────────────────────────────────────────
   Added 2026-09-22 for the quarter / year-to-date / custom-range filters.

   The endpoint has no pagination and truncates large ranges (defect 1 in
   odooDashboardClient.js), so a range longer than a month is fetched one
   CALENDAR month at a time and merged here. Whole months are requested
   even when the range starts or ends mid-month, for two reasons: the
   client caches a closed month for 12 h and only identical from/to hit
   that cache, and a quarter then costs three cached calls rather than one
   uncacheable bespoke one. The records are filtered back down to the
   requested range afterwards, so the extra days never reach a caller. */
const MAX_SLICES = 36; // 3 years — a guard against a runaway custom range

function _monthSlices(from, to) {
  const slices = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  while (slices.length < MAX_SLICES) {
    const mm = String(month).padStart(2, '0');
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const sliceTo = `${year}-${mm}-${String(last).padStart(2, '0')}`;
    slices.push([`${year}-${mm}-01`, sliceTo]);
    if (sliceTo >= to) break;
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return slices;
}

/* One merged bundle for [from..to]. Never throws; returns the same
   {ok:false,status,message} shape as the client.

   `partial_months` names slices that failed while others succeeded. A
   caller must surface that rather than present a short total as complete
   — the same rule fetchPoValueTrend already follows by rendering a failed
   month as a gap instead of a zero. */
async function fetchPurchaseRange(from, to) {
  if (!client.isConfigured()) {
    return { ok: false, status: 'not_configured', message: 'The Odoo dashboard API is not configured on this server yet.' };
  }

  const slices = _monthSlices(from, to);
  const bundles = new Array(slices.length).fill(null);
  const queue = slices.map((sl, i) => ({ i, from: sl[0], to: sl[1] }));
  const CONCURRENCY = 3;

  async function worker() {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      bundles[job.i] = await client.fetchPurchaseBundle(job.from, job.to);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const okBundles = bundles.filter(b => b && b.ok);
  if (!okBundles.length) {
    // Every slice failed — pass the first real reason through unchanged.
    const firstBad = bundles.find(b => b && !b.ok);
    return firstBad || { ok: false, status: 'unreachable', message: `Odoo returned nothing for ${from}..${to}.` };
  }

  const partial_months = slices
    .map((sl, i) => (bundles[i] && bundles[i].ok ? null : sl[0].slice(0, 7)))
    .filter(Boolean);

  /* Orders and their lines are disjoint across calendar months, so they
     concatenate. `products` and `product_categories` are NOT — the server
     re-sends (an incomplete slice of) them per range, defect 4 — so they
     are deduped by id, which as a side effect gives a range wider coverage
     of the catalogue than any single month has. */
  const orders = [];
  const lines = [];
  const productById = new Map();
  const categoryById = new Map();
  for (const b of okBundles) {
    for (const o of b.data.purchase_orders || []) orders.push(o);
    for (const l of b.data.purchase_order_lines || []) lines.push(l);
    for (const pr of b.data.products || []) if (!productById.has(pr.product_id)) productById.set(pr.product_id, pr);
    for (const c of b.data.product_categories || []) if (!categoryById.has(c.category_id)) categoryById.set(c.category_id, c);
  }

  /* Whole months were fetched, so trim back to what was asked for. An
     order with no order_date is kept: dropping it would under-report, and
     it is inside one of the fetched months by construction. */
  const inRange = orders.filter(o => {
    const d = (o.order_date || '').slice(0, 10);
    return !d || (d >= from && d <= to);
  });
  const keptIds = new Set(inRange.map(o => o.purchase_order_id));

  return {
    ok: true,
    data: {
      purchase_orders: inRange,
      purchase_order_lines: lines.filter(l => keptIds.has(l.purchase_order_id)),
      products: Array.from(productById.values()),
      product_categories: Array.from(categoryById.values()),
    },
    partial_months,
    as_of: new Date().toISOString(),
    source: 'odoo:purchase_dashboard_report',
  };
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

/* Open PR / Open PO by category (Service · Local · Import · Raw Material),
   each reported on four measures (2026-09-22, asked for by the business):

     No. of PR / PO   distinct documents with something still open
     No. of items     open order LINES — one PO of 12 materials is 12 items
     Quantity         sum of the still-pending quantity
     Value (TZS)      value of the pending quantity only, not the whole PO

   Quantity is deliberately NOT totalled across categories anywhere: the
   lines mix tonnes, litres, bags and pieces, so a combined figure would be
   a number with no unit. The page says so next to the row.

   Definitions confirmed by the business:
     Open PR — requisition approved, PO not yet created.
     Open PO — PO approved, GRN not yet made.

   Open PO is measured here as lines with pending_quantity > 0, which is
   "ordered and not yet fully received". That is the closest the current
   endpoint allows and it is NOT the same as the definition above: it also
   counts partially-received POs, and it cannot see whether the approval
   step was actually completed. Closing that gap needs `approval_status`
   and the GRN/receipt fields — see docs/ODOO_PURCHASE_API_REQUIREMENTS.md.

   The four columns are deliberately NOT mutually exclusive — a Raw
   Material PO is also Local or Import — so these are four independent
   filters over the same lines, not a partition.

   Open PR stays not_mapped on every measure: the endpoint carries no
   requisition data at all. */
async function fetchCategoryGrid(from, to) {
  const bundle = await fetchPurchaseRange(from, to);
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

  /* Line-level, not order-level. The previous version counted a whole
     order into the Raw Material column if any one of its lines was a raw
     material, and then added that order's entire open value. Measuring per
     line keeps each column's value to the lines that actually belong to
     it. Order-level columns (local / import / service) are unaffected —
     their predicate reads the parent order either way. */
  const openLines = [];
  for (const l of lines) {
    if (!(l.pending_quantity > 0)) continue;
    const order = orderById.get(l.purchase_order_id);
    if (!order) continue;
    const qty = l.quantity || 0;
    const unitValue = qty > 0 ? (l.line_amount || 0) / qty : 0;
    openLines.push({
      order,
      pending: l.pending_quantity,
      value: unitValue * l.pending_quantity,
      rawMaterial: rawMaterialProductIds.has(l.product_id),
    });
  }

  const cell = (predicate) => {
    const matched = openLines.filter(predicate);
    return {
      ok: true,
      documents: new Set(matched.map(e => e.order.purchase_order_id)).size,
      items: matched.length,
      quantity: Math.round(matched.reduce((s, e) => s + e.pending, 0) * 100) / 100,
      value_tzs: Math.round(matched.reduce((s, e) => s + e.value, 0)),
    };
  };

  const prPending = _notMapped(
    'Purchase Requisition data is not included in the Odoo dashboard endpoint — ' +
    'no PR number, requisition record, line count or quantity is returned. ' +
    'Requested from the Odoo team — see docs/ODOO_PURCHASE_API_REQUIREMENTS.md.');

  return {
    ok: true,
    value: {
      service:      { open_pr: prPending, open_po: cell(e => e.order.po_for_key === 'service') },
      local:        { open_pr: prPending, open_po: cell(e => e.order.purchase_type === 'local') },
      import:       { open_pr: prPending, open_po: cell(e => e.order.purchase_type === 'import') },
      raw_material: { open_pr: prPending, open_po: cell(e => e.rawMaterial) },
    },
    partial_months: bundle.partial_months,
    as_of: bundle.as_of,
    source: bundle.source,
  };
}

module.exports = { fetchPoValueTrend, fetchCategoryGrid, fetchPurchaseRange, _monthSlices };
