/*
  services/odooStoresSync.js — pull the three Stores endpoints into Postgres
  (migration 031) so the Raw Material and Stores reports read a local table
  instead of waiting on a 15-55s Odoo call.

  ── Why this is a sync and not a read-through ──────────────────────────
  Measured on production 2026-10-01: a two-day gate_entry pull is 15s, and a
  one-month pull TIMED OUT at 180s. grn_register is 40-55s for a month.
  Nothing in that range can sit in front of a page load, so the pulls run on
  a schedule (odooSync.js) and every reader queries Postgres.

  ── The rolling re-pull window, and the measurement behind it ──────────
  GRN is booked 0.1-5.1 days after the truck physically arrives (mean 1.5),
  measured over the 2026-09-16 exports. So a day's rows are NOT final when
  that day ends: a gate entry that was pending-GRN on Monday gets its GRN on
  Wednesday, and the Monday row has to change. Re-pulling a rolling window
  (default 7 days) is what makes the pending-GRN column eventually correct.
  Every upsert below is keyed on Odoo's own identifiers, so re-pulling the
  same window is idempotent — it rewrites rows with identical values.

  ── What this never does ───────────────────────────────────────────────
  It never overwrites a row whose `source` is 'excel'. Manual uploads are an
  operator's deliberate act; a schedule silently replacing them is the bug
  migration 016 introduced the source column to prevent.
*/
const db = require('../db');
const client = require('./odooStoresClient');
const log = require('./logger');

/* Odoo sends 'DD/MM/YYYY' or 'DD/MM/YYYY HH:mm:ss' — never ISO, and never
   with a timezone. Parsing this with `new Date(s)` is the trap: V8 reads
   '14/09/2026' as an invalid date on some inputs and as MONTH 14 on others,
   so a silent null or a year-shifted row is the failure mode. Parse the
   parts explicitly instead.

   The plant runs UTC+3 (Africa/Dar_es_Salaam) with no DST. These timestamps
   are wall-clock plant time, so they are anchored to +03:00 rather than
   assumed UTC — otherwise a 23:56 unloading (a real value in the 15 Sep
   sample) would land on the previous day once Postgres normalised it. */
const PLANT_OFFSET = '+03:00';

/* Matches ANYWHERE in the string, not anchored, and that is deliberate.
   On a multi-vendor "Others" token Odoo comma-joins every value into one
   field, so grn_date arrives as '16/09/2026, 16/09/2026, 15/09/2026, ...'.
   An anchored ^...$ match returns null for those rows — the row would load
   with a blank date and look like a data gap rather than a joined cell.
   Taking the FIRST date is the honest reduction: these rows describe one
   truck whose several GRNs were booked around the same time, and the first
   is the earliest in the order Odoo emits. */
const DATE_RE = /(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

function parseOdooTimestamp(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = s.match(DATE_RE);
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${PLANT_OFFSET}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* The DATE half of the same value, in plant-local terms. Taking date() off
   the timestamp in SQL would re-derive it in the server's zone, which on a
   UTC droplet moves a 23:56 unloading back a day. */
function parseOdooDay(value) {
  const m = String(value || '').trim().match(DATE_RE);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  return s === '' ? null : s;
}

/* Odoo writes a partner as '[CODE] Name' on gate entries but splits them on
   GRN lines. Pull the code out so both feeds key on the same thing — vendor
   NAMES change spelling in Odoo, codes do not. */
/* Only for the single-vendor case. A multi-vendor token joins several
   '[CODE] Name' pairs into one 154-char string, and picking the first code
   off that would label the whole truck with one of its several vendors —
   a wrong fact, not a partial one. Those return null, and the full joined
   string stays in `vendor` where a reader can see it is multi-vendor. */
function vendorCode(value) {
  const s = String(value || '');
  if (s.split('[').length > 2) return null;   // more than one '[CODE] ' present
  const m = s.match(/^\s*\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

/* ── Gate entries ──────────────────────────────────────────────────── */

const GATE_COLS = [
  'inward_token_no', 'token_date', 'token_type', 'status', 'cancel_reason',
  'vendor', 'vendor_code', 'vendor_dc_no', 'vendor_dc_date', 'po_ref', 'pr_ref',
  'material_code', 'material_desc', 'uom', 'challan_qty', 'net_weight',
  'gross_weight', 'tare_weight', 'unloading_end_time', 'receipt_date',
  'grn_no', 'grn_date', 'quantity', 'cost_unit_rate', 'value',
  'po_qty', 'po_balance_qty', 'truck_no', 'transporter_name', 'department',
];

function gateRow(r) {
  const token = str(r.inward_token_no);
  if (!token) return null;
  const unloadEnd = parseOdooTimestamp(r.unloading_end_time);
  return [
    token,
    parseOdooTimestamp(r.token_date),
    str(r.token_type),
    str(r.status),
    str(r.cancel_reason),
    str(r.vendor),
    vendorCode(r.vendor),
    str(r.vendor_dc_no),
    parseOdooDay(r.vendor_dc_date),
    str(r.po_ref),
    str(r.pr_ref),
    str(r.material_code),
    str(r.material_desc),
    str(r.uom),
    num(r.challan_qty),
    num(r.net_weight),
    num(r.gross_weight),
    num(r.tare_weight),
    unloadEnd,
    /* receipt_date is the day the truck FINISHED unloading, not the day the
       token was raised and not the GRN date — see the module header on the
       1.5-day GRN lag. A truck that enters at 23:00 and finishes at 01:30
       counts to the day it finished, which is what the stock ledger means by
       received. Falls back to the token day when unloading never completed
       (cancelled / still on site), so the row still lands on a day. */
    parseOdooDay(r.unloading_end_time) || parseOdooDay(r.token_date),
    str(r.grn_no),
    parseOdooTimestamp(r.grn_date),
    num(r.quantity),
    num(r.cost_unit_rate),
    num(r.value),
    num(r.po_qty),
    num(r.po_balance_qty),
    str(r.truck_no),
    str(r.transporter_name),
    str(r.department),
  ];
}

/* ── GRN lines ─────────────────────────────────────────────────────── */

const GRN_COLS = [
  'grn_no', 'item_code', 'line_seq', 'grn_date', 'grn_status', 'return_grn',
  'inward_token_no', 'po_no', 'po_date', 'purchase_type', 'vendor_code',
  'vendor_name', 'vendor_dc_no', 'vendor_dc_date', 'item_name', 'uom',
  'challan_qty', 'received_qty', 'qc_accepted_qty', 'qc_rejected_qty',
  'variance_qty', 'rate', 'value', 'freight', 'lc_amount',
  'weighbridge_net_qty', 'weighbridge_ticket_no', 'location_and_bin',
  'pr_no', 'department',
];

function grnRow(r, seq) {
  const grn = str(r.grn_no);
  const item = str(r.item_code);
  if (!grn || !item) return null;
  return [
    grn, item, seq,
    parseOdooTimestamp(r.grn_date),
    str(r.grn_status),
    str(r.return_grn),
    str(r.inward_token_no),
    str(r.po_no),
    parseOdooTimestamp(r.po_date),
    str(r.purchase_type),
    str(r.vendor_code) || vendorCode(r.vendor_name),
    str(r.vendor_name),
    str(r.vendor_dc_no),
    parseOdooDay(r.vendor_dc_date),
    str(r.item_name),
    str(r.uom),
    num(r.challan_qty),
    num(r.received_qty),
    num(r.qc_accepted_qty),
    num(r.qc_rejected_qty),
    num(r.variance_qty),
    num(r.rate),
    num(r.value),
    num(r.freight),
    num(r.lc_amount),
    num(r.weighbridge_net_qty),
    str(r.weighbridge_ticket_no),
    str(r.location_and_bin),
    str(r.pr_no),
    str(r.department),
  ];
}

/* ── Material issues ───────────────────────────────────────────────── */

const ISSUE_COLS = [
  'issue_no', 'line_seq', 'issue_date', 'issue_day', 'warehouse', 'department',
  'division', 'mrq_no', 'requested_date', 'creator', 'approved_by',
  'approved_date', 'product_code', 'product_name', 'uom', 'approved_quantity',
  'issued_quantity', 'equipment', 'analytic_account', 'storage_location',
  'status', 'force_closed', 'unit_cost', 'value', 'remarks',
];

function issueRow(r, seq) {
  const issueNo = str(r.issue_no);
  if (!issueNo) return null;
  return [
    issueNo, seq,
    parseOdooTimestamp(r.issue_date),
    parseOdooDay(r.issue_date),
    str(r.warehouse),
    str(r.department),
    str(r.division),
    str(r.mrq_no),
    parseOdooDay(r.requested_date),
    str(r.creator),
    str(r.approved_by),
    parseOdooTimestamp(r.approved_date),
    str(r.product_code),
    str(r.product_name),
    str(r.uom),
    num(r.approved_quantity),
    num(r.issued_quantity),
    str(r.equipment),
    str(r.analytic_account),
    str(r.storage_location),
    str(r.status),
    str(r.force_closed),
    num(r.unit_cost),
    num(r.value),
    str(r.remarks),
  ];
}

/* ── Upsert ────────────────────────────────────────────────────────── */

/* One multi-row INSERT per chunk rather than a statement per row: a month of
   gate entries is ~1,300 rows and a row-at-a-time loop makes that 1,300
   round trips. Chunked because Postgres caps a statement at 65,535 bound
   parameters and a 29-column row would blow that at ~2,250 rows. */
function chunkSize(colCount) {
  return Math.max(1, Math.floor(60000 / colCount));
}

async function upsertRows(dbc, table, cols, keyCols, rows) {
  if (!rows.length) return { written: 0, skippedExcel: 0 };

  const updatable = cols.filter(c => !keyCols.includes(c));
  const setClause = updatable.map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const size = chunkSize(cols.length);
  let written = 0;

  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    const params = [];
    const tuples = batch.map(row => {
      const ph = row.map(v => { params.push(v); return `$${params.length}`; });
      return `(${ph.join(',')})`;
    });
    const res = await dbc.query(
      `INSERT INTO ${table} (${cols.join(',')})
       VALUES ${tuples.join(',')}
       ON CONFLICT (${keyCols.join(',')}) DO UPDATE
         SET ${setClause}, source = 'odoo', synced_at = now()
       -- Never clobber a manual upload: an 'excel' row stays as the operator
       -- left it, and the scheduled pull reports it as skipped instead.
       WHERE ${table}.source <> 'excel'`,
      params);
    written += res.rowCount;
  }
  return { written, skippedExcel: rows.length - written };
}

/* ── Pulls ─────────────────────────────────────────────────────────── */

/* Odoo can repeat a (grn_no, item_code) pair when one GRN books the same
   item twice. line_seq disambiguates deterministically by position within
   the response, so a re-pull of an unchanged window produces the same keys
   rather than inventing new rows each time. */
function sequence(rows, keyOf) {
  const seen = new Map();
  return rows.map(r => {
    const k = keyOf(r);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n;
  });
}

async function pullGateEntries(from, to) {
  const raw = await client.fetchGateEntries(from, to);
  const rows = raw.map(gateRow).filter(Boolean);
  const res = await upsertRows(db, 'rm_gate_entries', GATE_COLS, ['inward_token_no'], rows);
  const pending = rows.filter(r => !r[GATE_COLS.indexOf('grn_no')]).length;
  return { dataset: 'gate-entries', from, to, fetched: raw.length, ...res, pendingGrn: pending };
}

async function pullGrnRegister(from, to) {
  const raw = await client.fetchGrnRegister(from, to);
  const seqs = sequence(raw, r => `${r.grn_no}|${r.item_code}`);
  const rows = raw.map((r, i) => grnRow(r, seqs[i])).filter(Boolean);
  const res = await upsertRows(db, 'rm_grn_lines', GRN_COLS, ['grn_no', 'item_code', 'line_seq'], rows);
  return { dataset: 'grn-register', from, to, fetched: raw.length, ...res };
}

async function pullMaterialIssues(from, to) {
  const raw = await client.fetchMaterialIssues(from, to);
  const seqs = sequence(raw, r => String(r.issue_no));
  const rows = raw.map((r, i) => issueRow(r, seqs[i])).filter(Boolean);
  const res = await upsertRows(db, 'stores_issues', ISSUE_COLS, ['issue_no', 'line_seq'], rows);
  return { dataset: 'material-issues', from, to, fetched: raw.length, ...res };
}

/* All three, sequentially. Sequential is deliberate: these are the slowest
   endpoints on the ERP (gate entry alone is 15s for two days) and running
   them in parallel against a box that also serves the plant's own Odoo users
   is how the cache-warmer incident started. */
async function pullAllStores(from, to) {
  const results = [];
  const errors = [];
  for (const [label, fn] of [
    ['gate-entries', pullGateEntries],
    ['grn-register', pullGrnRegister],
    ['material-issues', pullMaterialIssues],
  ]) {
    try {
      results.push(await fn(from, to));
    } catch (err) {
      /* One dataset failing must not lose the two that worked — the GRN feed
         going down should not also stop diesel consumption updating. */
      log.error({ err, dataset: label, from, to }, 'odoo stores pull failed');
      errors.push({ dataset: label, error: err.message });
    }
  }
  if (!results.length) {
    throw new Error(`All three Odoo stores pulls failed for ${from}..${to}: `
      + errors.map(e => `${e.dataset}: ${e.error}`).join('; '));
  }
  return { from, to, results, errors };
}

module.exports = {
  pullGateEntries,
  pullGrnRegister,
  pullMaterialIssues,
  pullAllStores,
  // exported for tests
  parseOdooTimestamp,
  parseOdooDay,
  vendorCode,
};
