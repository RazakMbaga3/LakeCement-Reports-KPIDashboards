/*
  services/salesOdoo.js — every Odoo-sourced number on the Sales dashboard,
  one function per metric.

  Contract: NEVER throws. Each function returns either
      { ok: true,  value, as_of, source }
  or  { ok: false, status: 'not_configured' | 'unreachable' | 'parse_error'
        | 'not_mapped', message: '<honest, user-facing reason>' }
  so routes/sales.js can Promise.all them and the page renders each tile's
  real state without one missing integration blanking the whole dashboard.

  ── 2026-09-03: rewritten onto the Odoo team's custom endpoint ──────────
  Model reads through the generic External API were never granted; the
  Odoo team delivered one aggregate endpoint per dashboard instead. All
  data here now comes from services/odooDashboardClient.js, which returns
  sale_orders, sale_order_lines, customer_invoices, customer_receipts,
  sales_targets and products for a date range.

  orders/lines are deliberately re-shaped here into the Odoo-RPC shapes
  services/sales.js already consumes (product_id/product_uom as [id, name]
  pairs, product_uom_qty, user_id, date_order). That keeps _buildGradeMix
  and friends untouched — the adapter lives at this boundary, not spread
  through the aggregation layer. Product display names are rebuilt as
  "[CODE] NAME" because _matchGrade() pins SUPER 42 to the literal
  "[FG001]" code, and the endpoint returns code and name separately.

  ── Known server-side defects this file works around or refuses to hide ─
    - customer_receipts IGNORES the date filter (95% of rows came back
      outside the requested range on test). fetchAdvance() therefore
      filters client-side; remove that once the endpoint is fixed.
    - sale_orders.salesperson returns the ORDER-ENTRY CLERK, not the field
      sales officer (6 distinct names on orders vs 13 on targets, only 1
      in common). Not actually a blocker, though: see
      fetchOfficerAchievement() below — the Sales team confirmed targets
      are set per CUSTOMER, so actuals are attributed via customer_id
      (reliable) joined against the month's own target sheet, sidestepping
      the broken salesperson field entirely.
    - customer_invoices carry no DUE date, only invoice_date, so ageing
      is by invoice date and says so rather than implying it is overdue
      ageing. See fetchAgewiseOutstanding().
*/
const client = require('./odooDashboardClient');

function _notMapped(message) {
  return { ok: false, status: 'not_mapped', message };
}

function _fail(bundle) {
  return { ok: false, status: bundle.status, message: bundle.message };
}

/* Tonne conversion — unchanged convention: a line already in a MT/tonne
   UoM counts directly, anything else is treated as 50kg bags (20 = 1 MT).
   Kept identical to _buildGradeMix()'s own per-line maths in sales.js so
   the grade shares always reconcile against this total. Non-cement lines
   (e.g. scrap sold by PCS) therefore land in the "Unmatched product"
   bucket, which is the honest signal rather than a silent exclusion. */
function _lineMt(uomName, qty) {
  return /MT|TON|TONNE/i.test(uomName || '') ? qty : qty / 20;
}

/* Re-shape the endpoint's flat rows into the RPC shapes sales.js expects. */
function _shapeOrdersAndLines(data) {
  const products = data.products || [];
  const displayName = new Map(
    products.map(p => [p.product_id, p.product_code ? `[${p.product_code}] ${p.product_name}` : p.product_name]));

  const orders = (data.sale_orders || []).map(o => ({
    id: o.sale_order_id,
    name: o.sale_order,
    date_order: o.order_date,
    partner_id: [o.customer_id, o.customer],
    user_id: [o.salesperson_id, o.salesperson], // NB: clerk, not officer — see header
    amount_total: o.total_amount,
    state: o.status,
  }));

  const lines = (data.sale_order_lines || []).map(l => ({
    order_id: [l.sale_order_id, l.sale_order],
    product_id: [l.product_id, displayName.get(l.product_id) || l.product],
    product_uom_qty: l.quantity,
    product_uom: [l.uom_id, l.uom],
  }));

  return { orders, lines };
}

/* MTD / on-date sales volume and value. */
async function fetchMtdSales(from, to) {
  const bundle = await client.fetchSaleBundle(from, to);
  if (!bundle.ok) return _fail(bundle);

  const { orders, lines } = _shapeOrdersAndLines(bundle.data);

  /* Per-day tonnes are accumulated in the same pass as the total, from the
     same _lineMt(), so the daily series can never drift from qty_mt. Dates
     are the order's UTC date, matching _todayActualFromOrders() in sales.js. */
  const dateOfOrder = new Map(orders.map(o => [o.id, String(o.date_order || '').slice(0, 10)]));
  const mtByDate = {};
  const qtyMt = lines.reduce((s, l) => {
    const uomName = Array.isArray(l.product_uom) ? l.product_uom[1] : l.product_uom;
    const mt = _lineMt(uomName, l.product_uom_qty || 0);
    const date = dateOfOrder.get(Array.isArray(l.order_id) ? l.order_id[0] : l.order_id);
    if (date) mtByDate[date] = (mtByDate[date] || 0) + mt;
    return s + mt;
  }, 0);

  /* Distinct customers with at least one order in the period — a simple
     partner_id count, no further Odoo round trip. */
  const activeCustomers = new Set(orders.map(o => Array.isArray(o.partner_id) ? o.partner_id[0] : o.partner_id)).size;

  return {
    ok: true,
    value: {
      order_count: orders.length,
      qty_mt: Math.round(qtyMt * 10) / 10,
      value_tzs: Math.round(orders.reduce((s, o) => s + (o.amount_total || 0), 0)),
      mt_by_date: mtByDate,
      active_customers: activeCustomers,
      orders, lines, // handed to services/sales.js for grade mix / on-date split / top customers
    },
    as_of: bundle.as_of,
    source: bundle.source,
  };
}

/* Invoiced / collected / outstanding for the period, plus a DSO-lite
   approximation.

   dso_lite_days = outstanding / (total_invoiced / days_elapsed), i.e. "at
   the current average daily invoicing rate, how many days of unpaid
   invoicing does the outstanding balance represent". This is NOT a true
   Days Sales Outstanding against due dates — same caveat as
   fetchAgewiseOutstanding(), for the same reason: the endpoint's invoices
   carry only invoice_date, no due date, so there is no way to measure
   actual overdue-ness, only an invoice-date-basis approximation. Callers
   must label it accordingly rather than present it as a textbook DSO. */
async function fetchCollections(from, to, daysElapsed) {
  const bundle = await client.fetchSaleBundle(from, to);
  if (!bundle.ok) return _fail(bundle);

  const invoices = bundle.data.customer_invoices || [];
  const totalInvoiced = invoices.reduce((s, i) => s + (i.total_amount || 0), 0);
  const totalOutstanding = invoices.reduce((s, i) => s + (i.residual_amount || 0), 0);
  const totalCollected = totalInvoiced - totalOutstanding;

  const avgDailyInvoiced = (daysElapsed && totalInvoiced) ? totalInvoiced / daysElapsed : null;
  const dsoLiteDays = (avgDailyInvoiced && totalOutstanding)
    ? Math.round((totalOutstanding / avgDailyInvoiced) * 10) / 10
    : (avgDailyInvoiced != null ? 0 : null);

  return {
    ok: true,
    value: {
      invoice_count: invoices.length,
      total_invoiced_tzs: Math.round(totalInvoiced),
      total_collected_tzs: Math.round(totalCollected),
      outstanding_tzs: Math.round(totalOutstanding),
      collection_rate_pct: totalInvoiced ? Math.round((totalCollected / totalInvoiced) * 1000) / 10 : 0,
      dso_lite_days: dsoLiteDays,
      dso_basis_note: 'Approximate — outstanding balance divided by the average daily invoiced ' +
                      'amount this month. The Odoo endpoint returns no due date, only invoice_date, ' +
                      'so this is not a true Days Sales Outstanding against payment terms.',
    },
    as_of: bundle.as_of,
    source: bundle.source,
  };
}

/* Receivables ageing.

   IMPORTANT: the endpoint returns no due date, only invoice_date, so the
   buckets below are age-since-INVOICE, not days-overdue. That is a real
   difference from Odoo's own Aged Receivable report (which ages against
   the due date) and the label says so, rather than quietly presenting one
   as the other. Ask the Odoo team for invoice_date_due to fix this. */
async function fetchAgewiseOutstanding(from, to) {
  const bundle = await client.fetchSaleBundle(from, to);
  if (!bundle.ok) return _fail(bundle);

  const invoices = (bundle.data.customer_invoices || []).filter(i => (i.residual_amount || 0) > 0);
  const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d91_120: 0, older: 0 };
  const today = Date.now();

  for (const inv of invoices) {
    if (!inv.invoice_date) continue;
    const ageDays = Math.floor((today - new Date(inv.invoice_date).getTime()) / 86400000);
    const amt = inv.residual_amount || 0;
    if (ageDays <= 30) buckets.d0_30 += amt;
    else if (ageDays <= 60) buckets.d31_60 += amt;
    else if (ageDays <= 90) buckets.d61_90 += amt;
    else if (ageDays <= 120) buckets.d91_120 += amt;
    else buckets.older += amt;
  }
  Object.keys(buckets).forEach(k => { buckets[k] = Math.round(buckets[k]); });

  return {
    ok: true,
    value: {
      ...buckets,
      total_tzs: Object.values(buckets).reduce((s, v) => s + v, 0),
      invoice_count: invoices.length,
      ageing_basis: 'invoice_date',
      basis_note: 'Aged by invoice date — the Odoo endpoint does not return a due date, ' +
                  'so these are not days-overdue buckets.',
    },
    as_of: bundle.as_of,
    source: bundle.source,
  };
}

/* Customer receipts in the period.

   Works around the endpoint returning receipts far outside the requested
   range (95% of rows on test): the filter is re-applied here. Without
   this the figure would silently include years of unrelated receipts. */
async function fetchAdvance(from, to) {
  const bundle = await client.fetchSaleBundle(from, to);
  if (!bundle.ok) return _fail(bundle);

  const all = bundle.data.customer_receipts || [];
  const inRange = all.filter(r =>
    r.payment_type === 'inbound' && r.receipt_date && r.receipt_date >= from && r.receipt_date <= to);

  return {
    ok: true,
    value: {
      receipt_count: inRange.length,
      total_tzs: Math.round(inRange.reduce((s, r) => s + (r.amount || 0), 0)),
      filtered_client_side: true,
      rows_returned_by_odoo: all.length,
      note: all.length > inRange.length
        ? `Odoo returned ${all.length} receipts for this request and ignored the date filter; ` +
          `${inRange.length} actually fall inside the period and only those are counted.`
        : null,
    },
    as_of: bundle.as_of,
    source: bundle.source,
  };
}

/* Officer achievement for the month — the CORRECT attribution model,
   confirmed by the Sales team 2026-09-03 after the salesperson-field
   defect was reported: targets in Odoo (custom.sales.target) are set per
   CUSTOMER, not per officer directly, and each customer is permanently
   assigned to one sales officer. An officer's achievement is the sum of
   what THEIR assigned customers actually ordered that month, not
   whatever "salesperson" happens to be stamped on the order (already
   confirmed to be the order-entry clerk, not the officer).

   This makes the earlier ask to Odoo -- fix sale_orders.salesperson, add
   division/zone to sale_orders -- unnecessary for this purpose. The same
   bundle already carries everything needed:
     sales_targets: customer_id -> {salesperson, division, zone, target}
     sale_orders:   customer_id (a standard, reliable field, unlike
                    salesperson) + the order lines to attribute
   so actual sales are attributed via the CUSTOMER, joined against this
   month's own target sheet -- entirely from data already in hand, with
   no further Odoo changes required.

   Orders whose customer has no target line this month (a new customer, a
   one-off/walk-in sale) cannot be attributed to an officer. Those are
   reported separately as `unassigned` rather than silently dropped or
   guessed at -- the same honest-degradation pattern as the grade mix's
   "Unmatched product" bucket. */
async function fetchOfficerAchievement(from, to) {
  const bundle = await client.fetchSaleBundle(from, to);
  if (!bundle.ok) return _fail(bundle);

  const targetRows = bundle.data.sales_targets || [];
  if (!targetRows.length) {
    return _notMapped('Odoo returned no sales targets for this period, so actual sales cannot be attributed to officers.');
  }

  // customer_id -> that customer's target row (division/zone/officer/qty)
  const customerTarget = new Map();
  const officers = new Map(); // salesperson name -> aggregate across their customers
  for (const r of targetRows) {
    if (r.customer_id != null) customerTarget.set(r.customer_id, r);
    const key = r.salesperson || 'Unassigned';
    if (!officers.has(key)) {
      officers.set(key, {
        salesperson: r.salesperson, salesperson_id: r.salesperson_id,
        division: r.division, zone: r.zone,
        target_mt: 0, actual_mt: 0, customer_count: 0,
      });
    }
    const o = officers.get(key);
    o.target_mt += r.total_target_qty || 0;
    o.customer_count += 1;
  }

  const orderCustomer = new Map();
  for (const o of bundle.data.sale_orders || []) orderCustomer.set(o.sale_order_id, o.customer_id);

  let unassignedMt = 0;
  const unassignedOrders = new Set();
  for (const line of bundle.data.sale_order_lines || []) {
    const cid = orderCustomer.get(line.sale_order_id);
    const mt = _lineMt(line.uom, line.quantity || 0);
    const target = cid != null ? customerTarget.get(cid) : null;
    if (!target) {
      unassignedMt += mt;
      unassignedOrders.add(line.sale_order_id);
      continue;
    }
    officers.get(target.salesperson || 'Unassigned').actual_mt += mt;
  }

  const officerList = Array.from(officers.values()).map(o => ({
    ...o,
    target_mt: Math.round(o.target_mt * 10) / 10,
    actual_mt: Math.round(o.actual_mt * 10) / 10,
    achievement_pct: o.target_mt ? Math.round((o.actual_mt / o.target_mt) * 1000) / 10 : null,
  })).sort((a, b) => b.target_mt - a.target_mt);

  const byDivisionMap = new Map();
  for (const o of officerList) {
    const key = o.division || 'Unassigned';
    if (!byDivisionMap.has(key)) byDivisionMap.set(key, { division: key, target_mt: 0, actual_mt: 0 });
    const d = byDivisionMap.get(key);
    d.target_mt += o.target_mt;
    d.actual_mt += o.actual_mt;
  }
  const byDivision = Array.from(byDivisionMap.values()).map(d => ({
    ...d,
    target_mt: Math.round(d.target_mt * 10) / 10,
    actual_mt: Math.round(d.actual_mt * 10) / 10,
    achievement_pct: d.target_mt ? Math.round((d.actual_mt / d.target_mt) * 1000) / 10 : null,
  })).sort((a, b) => b.target_mt - a.target_mt);

  return {
    ok: true,
    value: {
      officers: officerList,
      by_division: byDivision,
      unassigned_mt: Math.round(unassignedMt * 10) / 10,
      unassigned_order_count: unassignedOrders.size,
      customer_count: customerTarget.size,
      company_target_mt: Math.round(officerList.reduce((s, o) => s + o.target_mt, 0) * 10) / 10,
      company_actual_mt: Math.round((officerList.reduce((s, o) => s + o.actual_mt, 0) + unassignedMt) * 10) / 10,
    },
    as_of: bundle.as_of,
    source: bundle.source,
  };
}

/* No source in either endpoint. */
async function fetchReceivedUncollectable() {
  return _notMapped('Received Uncollectable is not included in the Odoo dashboard endpoint.');
}

async function fetchPayable() {
  return _notMapped(
    'Vendor payables are not included in either Odoo dashboard endpoint — the sales endpoint ' +
    'returns customer invoices only, and the purchase endpoint returns no vendor bills.');
}

module.exports = {
  fetchMtdSales, fetchCollections,
  fetchReceivedUncollectable, fetchPayable, fetchAdvance, fetchAgewiseOutstanding,
  fetchOfficerAchievement,
  /* Exported so services/sales.js shares this one definition of the
     bag->tonne rule instead of keeping its own inline copies; the grade
     shares and top-customer totals must reconcile against qty_mt, which
     is computed here. */
  _lineMt,
};
