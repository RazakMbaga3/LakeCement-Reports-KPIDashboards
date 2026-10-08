/*
  services/odooSalesSync.js — mirror Odoo's Sale Register feed
  (sale_dashboard_report, reshaped 2026-10-08) into Postgres (migration 034).

  ── What the feed is ──────────────────────────────────────────────────
  One row per posted customer invoice, with its product lines, delivery-note
  stock moves and the customer receipts applied to it nested inside. It is
  the Sales team's SALE REGISTER: for September 2026 every one of the
  Register's 2,003 invoices is present with the same tonnage, and untaxed
  amount equals the Register's NET to the shilling. Filter it by
  invoice_date — that is how the Register is built (462.9 MT of the
  September Register was delivered in August).

  ── Why one day per request ───────────────────────────────────────────
  ~0.27 s per invoice on the production ERP: 2 days took 53 s, a month
  (~2,000 invoices) ~9 minutes, and the client's 180 s timeout fails long
  before that. A day is 25-60 s — inside the timeout, and small enough that
  the bundle (~0.5 MB) never threatens pm2's 300 MB limit.

  ── The three traps, resolved here once ───────────────────────────────
  1. Excise. Nearly every invoice carries a productless line at 1,080 TZS
     per bag (21,600 per MT bulk) whose `quantity` repeats the bag count, so
     the invoice-level `quantity` double-counts bags on ~every invoice. It is
     never read. Tonnage comes from product lines, classified below.
  2. Receipts. `collection_amount` is the WHOLE receipt, repeated on every
     invoice it paid; summed over two days it read 8.7B against 1.7B
     actually paid. Receipts are stored once by receipt_id with a link
     table, and collection_amount is never stored at all.
  3. Delivery partner. A delivery's customer_id is the delivery-address
     contact, not the invoice customer. Customer always comes from the
     invoice.

  ── Re-pulling, and why rows can disappear ────────────────────────────
  An invoice's payment_status and residual change after it is issued, so
  days are re-pulled (see pullSalesRegisterLive). Each day is replaced as a
  unit: its invoices are upserted, their lines/deliveries/receipt links are
  rewritten, and invoices WE hold for that day that Odoo no longer returns
  are deleted — that is a cancelled or reversed invoice, and keeping it
  would overstate sales. The one exception: an EMPTY answer for a day we
  hold invoices for is never trusted to wipe it. A day genuinely going from
  N invoices to 0 is rare; Odoo returning [] in error is not, and the cost
  of the two mistakes is not symmetric.
*/
const db = require('../db');
const { fetchSaleBundle } = require('./odooDashboardClient');
const { PRODUCT_CODE_GRADE } = require('../config/salesGrades');
const log = require('./logger');

/* ── Classification ──────────────────────────────────────────────── */

/* Tonnes for a product line from its UoM. Only units actually observed are
   converted ('MT', and 'NN KG BAG' — '50 KG BAG' is 50/1000 t per bag). Any
   other unit returns null rather than a guess: a 25 kg bag silently counted
   as a 50 kg one is exactly the kind of error that survives every test. */
function lineTonnes(quantity, uom) {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return null;
  const u = String(uom || '').trim().toUpperCase();
  if (u === 'MT' || u === 'TON' || u === 'TONNE' || u === 'TONNES') return q;
  const bag = u.match(/^(\d+(?:\.\d+)?)\s*KG\s*BAG$/);
  if (bag) return q * Number(bag[1]) / 1000;
  return null;
}

/* Cement is identified by the product name, the same way the Register's
   ITEM DESCRIPTION column is — every cement product is named "CEMENT …",
   and the non-cement lines seen (FLY ASH, SCRAP STEEL) are not. */
function isCementProduct(name) {
  return /^CEMENT\b/i.test(String(name || '').trim());
}

const n = v => (v === null || v === undefined || v === '' || v === false ? null : Number(v));
const s = v => (v === null || v === undefined || v === false ? null : String(v));
const day = v => (v ? String(v).slice(0, 10) : null);

/* One feed invoice -> the rows for every table, plus anything that could
   not be classified (counted in the run result, never silently dropped). */
function mapInvoice(inv) {
  if (!inv || !inv.invoice_id || !inv.invoice_number || !inv.invoice_date) {
    return { rejected: true };
  }
  const unknownUom = [];
  let cementMt = 0, nonCementMt = 0, excise = 0, cementLines = 0;

  const lines = (inv.invoice_lines || []).filter(l => l && l.line_id).map(l => {
    const isProduct = !!l.product_id && !!l.product;
    if (!isProduct) {
      excise += Number(l.amount) || 0;
      return [l.line_id, inv.invoice_id, 'charge', null, null, null, n(l.quantity), s(l.uom) || null,
              null, null, false, n(l.rate), n(l.amount), n(l.taxed_amount)];
    }
    const cement = isCementProduct(l.product);
    const mt = lineTonnes(l.quantity, l.uom);
    if (mt === null) unknownUom.push({ invoice: inv.invoice_number, product: l.product, uom: l.uom });
    else if (cement) { cementMt += mt; cementLines++; }
    else nonCementMt += mt;
    const code = s(l.product_code) || null;
    return [l.line_id, inv.invoice_id, 'product', n(l.product_id), s(l.product), code,
            n(l.quantity), s(l.uom), mt, cement ? (PRODUCT_CODE_GRADE[code] || null) : null, cement,
            n(l.rate), n(l.amount), n(l.taxed_amount)];
  });

  const deliveries = [];
  for (const d of inv.delivery_details || []) {
    for (const m of d.delivery_lines || []) {
      if (!m || !m.move_id) continue;
      deliveries.push([m.move_id, inv.invoice_id, n(d.delivery_id), s(d.delivery_number),
        s(d.delivery_date), s(d.scheduled_date), s(d.delivery_status), s(d.origin), s(d.customer),
        s(d.source_location), s(d.destination_location),
        n(m.product_id), s(m.product), s(m.product_code), n(m.quantity), n(m.delivered_quantity), s(m.uom)]);
    }
  }

  const receipts = (inv.customer_receipts || []).filter(r => r && r.receipt_id).map(r =>
    [r.receipt_id, s(r.receipt_number), day(r.receipt_date), n(r.amount), s(r.payment_type), s(r.currency)]);

  const invoice = [inv.invoice_id, s(inv.invoice_number), day(inv.invoice_date),
    n(inv.customer_id), s(inv.customer), s(inv.customer_code),
    n(inv.sale_order_id), s(inv.sale_order), s(inv.sale_order_ids), day(inv.sale_order_date),
    s(inv.status), s(inv.payment_status), n(inv.salesperson_id), s(inv.salesperson),
    n(inv.division_id), s(inv.division), n(inv.zone_id), s(inv.zone), n(inv.region_id), s(inv.region),
    s(inv.currency), n(inv.untaxed_amount), n(inv.tax_amount), n(inv.total_amount), n(inv.residual_amount),
    round3(cementMt), round3(nonCementMt), Math.round(excise * 100) / 100, cementLines > 0];

  return { invoice, lines, deliveries, receipts, unknownUom };
}

function round3(v) { return Math.round(v * 1000) / 1000; }

const INVOICE_COLS = ['invoice_id', 'invoice_number', 'invoice_date', 'customer_id', 'customer_name',
  'customer_code', 'sale_order_id', 'sale_order', 'sale_order_ids', 'sale_order_date', 'status',
  'payment_status', 'salesperson_id', 'salesperson', 'division_id', 'division', 'zone_id', 'zone',
  'region_id', 'region', 'currency', 'untaxed_amount', 'tax_amount', 'total_amount', 'residual_amount',
  'cement_mt', 'non_cement_mt', 'excise_amount', 'is_cement'];
const LINE_COLS = ['line_id', 'invoice_id', 'line_kind', 'product_id', 'product', 'product_code',
  'quantity', 'uom', 'qty_mt', 'grade_key', 'is_cement', 'rate', 'amount', 'taxed_amount'];
const DELIVERY_COLS = ['move_id', 'invoice_id', 'delivery_id', 'delivery_number', 'delivery_date',
  'scheduled_date', 'delivery_status', 'origin', 'delivery_partner', 'source_location',
  'destination_location', 'product_id', 'product', 'product_code', 'quantity', 'delivered_quantity', 'uom'];
const RECEIPT_COLS = ['receipt_id', 'receipt_number', 'receipt_date', 'amount', 'payment_type', 'currency'];

/* ── Writes ──────────────────────────────────────────────────────── */

/* Multi-row INSERT in chunks under Postgres's 65,535-parameter cap — same
   approach as odooStoresSync.js. `onConflict` is the full ON CONFLICT clause. */
async function insertRows(dbc, table, cols, rows, onConflict) {
  if (!rows.length) return 0;
  const size = Math.max(1, Math.floor(60000 / cols.length));
  let written = 0;
  for (let i = 0; i < rows.length; i += size) {
    const params = [];
    const tuples = rows.slice(i, i + size).map(row =>
      `(${row.map(v => { params.push(v); return `$${params.length}`; }).join(',')})`);
    const res = await dbc.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${onConflict}`, params);
    written += res.rowCount;
  }
  return written;
}

const updateAll = (cols, key, extra = '') =>
  `ON CONFLICT (${key}) DO UPDATE SET ${cols.filter(c => c !== key).map(c => `${c} = EXCLUDED.${c}`).join(', ')}${extra}`;

/* Last row per key wins — a feed that repeats a key within one response
   would otherwise make a single multi-row INSERT fail ("cannot affect row a
   second time"). */
function dedupe(rows) {
  const m = new Map();
  for (const r of rows) m.set(r[0], r);
  return [...m.values()];
}

/* Store one day of the feed, as one transaction. */
async function storeDay(dateStr, invoices) {
  const mapped = invoices.map(mapInvoice);
  const ok = mapped.filter(m => !m.rejected);
  const rejected = mapped.length - ok.length;

  const invRows = dedupe(ok.map(m => m.invoice));
  const ids = invRows.map(r => r[0]);
  const lineRows = dedupe(ok.flatMap(m => m.lines));
  const delRows = dedupe(ok.flatMap(m => m.deliveries));
  const rcptRows = dedupe(ok.flatMap(m => m.receipts));
  const links = [...new Set(ok.flatMap(m => m.receipts.map(r => `${m.invoice[0]}|${r[0]}`)))]
    .map(k => k.split('|').map(Number));
  const unknownUom = ok.flatMap(m => m.unknownUom);

  const dbc = await db.connect();
  try {
    await dbc.query('BEGIN');

    let pruned = 0, pruneSkipped = false;
    const held = Number((await dbc.query(
      'SELECT count(*)::int AS c FROM odoo_sale_invoices WHERE invoice_date = $1', [dateStr])).rows[0].c);
    if (invRows.length) {
      pruned = (await dbc.query(
        'DELETE FROM odoo_sale_invoices WHERE invoice_date = $1 AND NOT (invoice_id = ANY($2::bigint[]))',
        [dateStr, ids])).rowCount;
    } else if (held) {
      pruneSkipped = true;   // see header: an empty answer never wipes a held day
    }

    await insertRows(dbc, 'odoo_sale_invoices', INVOICE_COLS, invRows,
      updateAll(INVOICE_COLS, 'invoice_id', ', synced_at = now()'));
    if (ids.length) {
      /* Children are rewritten wholesale, so a line or delivery Odoo dropped
         from an invoice can't linger. */
      await dbc.query('DELETE FROM odoo_sale_invoice_lines WHERE invoice_id = ANY($1::bigint[])', [ids]);
      await dbc.query('DELETE FROM odoo_sale_delivery_lines WHERE invoice_id = ANY($1::bigint[])', [ids]);
      await dbc.query('DELETE FROM odoo_sale_invoice_receipts WHERE invoice_id = ANY($1::bigint[])', [ids]);
    }
    await insertRows(dbc, 'odoo_sale_invoice_lines', LINE_COLS, lineRows, updateAll(LINE_COLS, 'line_id'));
    await insertRows(dbc, 'odoo_sale_delivery_lines', DELIVERY_COLS, delRows, updateAll(DELIVERY_COLS, 'move_id'));
    await insertRows(dbc, 'odoo_sale_receipts', RECEIPT_COLS, rcptRows,
      updateAll(RECEIPT_COLS, 'receipt_id', ', synced_at = now()'));
    await insertRows(dbc, 'odoo_sale_invoice_receipts', ['invoice_id', 'receipt_id'], links,
      'ON CONFLICT DO NOTHING');

    await dbc.query('COMMIT');

    if (unknownUom.length) log.warn({ date: dateStr, unknownUom }, 'odoo sales: product lines with an unconverted UoM');
    if (pruneSkipped) log.warn({ date: dateStr, held }, 'odoo sales: empty answer for a day we hold invoices for — not pruned');

    return {
      date: dateStr,
      fetched: invoices.length,
      stored: invRows.length,
      rejected,
      pruned,
      pruneSkipped,
      cementMt: round3(invRows.reduce((t, r) => t + r[INVOICE_COLS.indexOf('cement_mt')], 0)),
      unknownUom: unknownUom.length,
    };
  } catch (err) {
    await dbc.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    dbc.release();
  }
}

/* ── Pulls ───────────────────────────────────────────────────────── */

async function pullSalesDay(dateStr) {
  const t0 = Date.now();
  const bundle = await fetchSaleBundle(dateStr, dateStr, { noCache: true });
  if (!bundle.ok) throw new Error(`Odoo sales feed ${bundle.status} for ${dateStr}: ${bundle.message}`);
  /* A shape check, not a formality: on 2026-10-08 this endpoint changed shape
     without notice, and code that defaulted a missing array to [] reported
     zero sales instead of failing. Missing `invoices` is an error. */
  if (!Array.isArray(bundle.data && bundle.data.invoices)) {
    throw new Error(`Odoo sales feed for ${dateStr} has no data.invoices array — the feed format changed again`);
  }
  const res = await storeDay(dateStr, bundle.data.invoices);
  return { ...res, secs: Math.round((Date.now() - t0) / 100) / 10 };
}

function isoDay(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return isoDay(d);
}

/* Inclusive range, one day at a time, SEQUENTIALLY — never in parallel
   against an ERP that also serves the plant's own users. One bad day does
   not stop the rest; the run fails only if every day failed. */
async function pullSalesRange(from, to, { onDay } = {}) {
  const days = [];
  for (let d = new Date(`${from}T00:00:00Z`); isoDay(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) days.push(isoDay(d));
  const results = [], errors = [];
  for (const dStr of days) {
    try {
      const r = await pullSalesDay(dStr);
      results.push(r);
      if (onDay) onDay(r);
    } catch (err) {
      log.error({ err, date: dStr }, 'odoo sales pull failed for day');
      errors.push({ date: dStr, error: err.message });
      if (onDay) onDay({ date: dStr, error: err.message });
    }
  }
  if (days.length && !results.length) {
    throw new Error(`Odoo sales pull failed for every day ${from}..${to}: ${errors[0].error}`);
  }
  return { from, to, days: days.length, results, errors };
}

/* The scheduled pull: today, yesterday, and ONE older day from a rotating
   cursor that walks back through the last SALES_REFRESH_DAYS days.

   Why the cursor: an invoice's payment status keeps changing after the day
   it was issued, so old days need re-pulling — but re-pulling 45 days every
   30 minutes would be ~20 minutes of ERP time per tick. One extra day per
   tick re-checks the whole window about once a day for ~a third more cost.

   Why the cursor is persisted (read back from this pull's own last result
   in odoo_sync_state) and not kept in memory: deploys restart the app
   several times a day, and an in-memory cursor would restart at day 2 every
   time and never reach the older end of the window. Likewise the daily
   ODOO_SYNC_CRON job ships `off` on the droplet, so a "nightly deep
   refresh" there would silently never run — this keeps refresh on the live
   schedule, which does run. */
const REFRESH_DAYS = Math.max(3, parseInt(process.env.SALES_REFRESH_DAYS || '45', 10));
const PULL_NAME = 'sales-register';

async function pullSalesRegisterLive(now = new Date()) {
  let cursor = 2;
  try {
    const row = (await db.query(
      'SELECT last_result FROM odoo_sync_state WHERE pull_name = $1', [PULL_NAME])).rows[0];
    const c = row && row.last_result && Number(row.last_result.next_cursor);
    if (Number.isInteger(c) && c >= 2 && c <= REFRESH_DAYS) cursor = c;
  } catch { /* no state yet — start at day 2 */ }

  const days = [daysAgo(0, now), daysAgo(1, now), daysAgo(cursor, now)];
  const results = [], errors = [];
  for (const dStr of days) {
    try { results.push(await pullSalesDay(dStr)); }
    catch (err) { log.error({ err, date: dStr }, 'odoo sales live pull failed for day'); errors.push({ date: dStr, error: err.message }); }
  }
  if (!results.length) throw new Error(`Odoo sales live pull failed for ${days.join(', ')}: ${errors[0].error}`);

  return {
    days,
    refreshed_day: days[2],
    next_cursor: cursor >= REFRESH_DAYS ? 2 : cursor + 1,
    stored: results.reduce((t, r) => t + r.stored, 0),
    pruned: results.reduce((t, r) => t + r.pruned, 0),
    results,
    errors,
  };
}

module.exports = {
  pullSalesDay,
  pullSalesRange,
  pullSalesRegisterLive,
  PULL_NAME,
  // exported for tests
  mapInvoice,
  lineTonnes,
  isCementProduct,
  storeDay,
};
