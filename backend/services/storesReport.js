/*
  services/storesReport.js — the Raw Material and Stores reports, read from
  the tables odooStoresSync.js fills (migration 031).

  Everything here queries Postgres. Nothing calls Odoo: a gate-entry pull is
  15s and a month of GRN 40-55s, which is why the pull is scheduled and the
  read is local. See odooStoresClient.js for the measurements.

  ── What "received" means here, and why it is not the GRN ──────────────
  Received is keyed on the GATE entry's unloading-end day, not the GRN date.
  GRN is booked 0.1-5.1 days after the truck arrives (mean 1.5, measured on
  the 2026-09-16 exports), so a GRN-dated "received today" understates stock
  for days and then dumps a backlog into one day. The gate row is the timely,
  physical fact; the GRN is the accounting confirmation, and the gap between
  them is itself a reported number (pending GRN).

  ── Weighbridge net is in KG ───────────────────────────────────────────
  rm_gate_entries.net_weight comes from Odoo in kilograms (31,780 for a
  31.78 MT truck — confirmed against the GRN line's own 31.78 MT on the same
  token). Everything the report prints is MT, so it is divided here, once,
  rather than in each caller.
*/
const db = require('../db');
const { resolveRow, COAL_VENDORS, SIMPLE_MATERIALS } = require('../config/odooMaterialMap');

const KG_PER_MT = 1000;

function toMt(kg) {
  const n = Number(kg);
  return Number.isFinite(n) ? n / KG_PER_MT : 0;
}
function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

/* ── Raw material receipts ─────────────────────────────────────────── */

/* Receipts for a day, grouped onto the report's rows.

   Cancelled tokens contribute zero: a cancelled truck never delivered, and
   summing it would inflate stock. Odoo marks these with a non-empty
   cancel_reason (status 'Exit' alone does NOT mean good — a cancelled token
   can still have exited the gate). */
async function receiptsForDate(date) {
  const { rows } = await db.query(
    `SELECT material_code, material_desc, vendor, vendor_code,
            net_weight, challan_qty, quantity, cost_unit_rate, value,
            grn_no, inward_token_no, truck_no
       FROM rm_gate_entries
      WHERE receipt_date = $1
        AND token_type = 'Raw Material'
        AND (cancel_reason IS NULL OR cancel_reason = '')
      ORDER BY unloading_end_time`,
    [date]);

  const byRow = new Map();
  const unassigned = [];

  for (const r of rows) {
    const res = resolveRow({
      itemCode: r.material_code,
      vendorName: r.vendor,
      vendorCode: r.vendor_code,
    });
    const mt = toMt(r.net_weight);

    if (!res.assigned) {
      /* Surfaced, never folded into a mapped row. An officer seeing 30 MT
         against an unknown supplier code can fix config/odooMaterialMap.js;
         an officer seeing it silently added to Kiln cannot. */
      unassigned.push({
        token: r.inward_token_no,
        truck: r.truck_no,
        material: r.material_desc || r.material_code,
        material_code: r.material_code,
        vendor: r.vendor,
        vendor_code: res.vendorCode,
        mt: round(mt, 3),
        reason: res.material
          ? 'Supplier not mapped to a Kiln or CPP row'
          : 'Material code not recognised',
      });
      continue;
    }

    const key = res.row;
    if (!byRow.has(key)) {
      byRow.set(key, {
        row: key,
        material: res.material,
        destination: res.destination,
        label: res.label || SIMPLE_MATERIALS[res.material] || key,
        mt: 0, trucks: 0, pending_grn_mt: 0, pending_grn_trucks: 0,
      });
    }
    const agg = byRow.get(key);
    agg.mt += mt;
    agg.trucks += 1;
    if (!r.grn_no) {
      agg.pending_grn_mt += mt;
      agg.pending_grn_trucks += 1;
    }
  }

  for (const agg of byRow.values()) {
    agg.mt = round(agg.mt, 3);
    agg.pending_grn_mt = round(agg.pending_grn_mt, 3);
  }

  return { rows: [...byRow.values()], unassigned };
}

/* ── Valuation ─────────────────────────────────────────────────────── */

/* Value received in a window, from the GRN lines (the accounting side —
   rate x qty is only known once the GRN is booked).

   Deliberately NOT derived from the gate entries: a gate row's cost_unit_rate
   is blank until its GRN lands, so valuing receipts off the gate feed would
   report zero for every truck still pending. Valuation answers "what did we
   book", which is a GRN question; tonnage answers "what arrived", which is a
   gate question. Keeping them on their own sources is why both are true. */
async function valuationForRange(from, to) {
  const { rows } = await db.query(
    `SELECT item_code, item_name,
            count(*)::int                       AS lines,
            sum(received_qty)                   AS qty,
            sum(value)                          AS value_tzs,
            sum(freight)                        AS freight_tzs,
            sum(lc_amount)                      AS landed_tzs,
            avg(rate) FILTER (WHERE rate > 0)   AS avg_rate
       FROM rm_grn_lines
      WHERE grn_date::date BETWEEN $1 AND $2
        AND (return_grn IS NULL OR return_grn = '')
      GROUP BY item_code, item_name
      ORDER BY sum(value) DESC NULLS LAST`,
    [from, to]);

  return rows.map(r => ({
    item_code: r.item_code,
    item_name: r.item_name,
    lines: r.lines,
    qty: round(r.qty, 3),
    /* A weighted rate, not the mean of the per-line rates: the same material
       arrives on several POs at different prices (coal 100k/105k on one day),
       and an unweighted mean would misprice a day where one big truck came in
       cheap. avg_rate is kept alongside only as a sanity check. */
    weighted_rate: r.qty > 0 ? round(Number(r.value_tzs) / Number(r.qty), 2) : null,
    simple_avg_rate: r.avg_rate === null ? null : round(r.avg_rate, 2),
    value_tzs: round(r.value_tzs, 2),
    freight_tzs: round(r.freight_tzs, 2),
    landed_tzs: round(r.landed_tzs, 2),
  }));
}

/* ── Pending GRN ───────────────────────────────────────────────────── */

/* Trucks that physically delivered but have no GRN yet, oldest first.
   This is the Raw Material Report's "PENDING GRN QTY" column, and an ageing
   list in its own right — a token pending for 5+ days is past the observed
   maximum lag and worth chasing. */
async function pendingGrn(asOf) {
  const { rows } = await db.query(
    `SELECT inward_token_no, truck_no, vendor, material_code, material_desc,
            receipt_date, net_weight,
            ($1::date - receipt_date)::int AS days_pending
       FROM rm_gate_entries
      WHERE (grn_no IS NULL OR grn_no = '')
        AND token_type = 'Raw Material'
        AND (cancel_reason IS NULL OR cancel_reason = '')
        AND receipt_date IS NOT NULL
        AND receipt_date <= $1::date
      ORDER BY receipt_date ASC`,
    [asOf]);

  return rows.map(r => ({
    token: r.inward_token_no,
    truck: r.truck_no,
    vendor: r.vendor,
    material: r.material_desc || r.material_code,
    receipt_date: r.receipt_date,
    mt: round(toMt(r.net_weight), 3),
    days_pending: r.days_pending,
    /* 5.1 days was the slowest GRN in the sample; past that it is no longer
       normal lag and the officer should be told so explicitly. */
    overdue: r.days_pending > 5,
  }));
}

/* ── Stores issues (diesel and everything else) ────────────────────── */

/* Consumption for a day. `product` filters to one item (the diesel report
   passes FUEL DIESEL); omitted, it returns every issued item.

   Grouped three ways because the Diesel Consumption Report is three pivots
   of the same rows: by department (the SUMMARY sheet), by analytic account
   (the DAILY CONSUMPTION sheet, which is equipment/vehicle) and the raw
   lines underneath. */
async function issuesForDate(date, { product = null } = {}) {
  const params = [date];
  let filter = '';
  if (product) { params.push(product); filter = ' AND product_name = $2'; }

  const { rows } = await db.query(
    `SELECT product_code, product_name, uom, department, division,
            analytic_account, equipment, issue_no, mrq_no,
            issued_quantity, unit_cost, value, status
       FROM stores_issues
      WHERE issue_day = $1
        AND status <> 'Cancelled'${filter}
      ORDER BY department, analytic_account`,
    params);

  const sumBy = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key] || '(unassigned)';
      const cur = m.get(k) || { key: k, qty: 0, value_tzs: 0, lines: 0 };
      cur.qty += Number(r.issued_quantity) || 0;
      cur.value_tzs += Number(r.value) || 0;
      cur.lines += 1;
      m.set(k, cur);
    }
    return [...m.values()]
      .map(x => ({ ...x, qty: round(x.qty, 2), value_tzs: round(x.value_tzs, 2) }))
      .sort((a, b) => b.qty - a.qty);
  };

  const total = rows.reduce((s, r) => s + (Number(r.issued_quantity) || 0), 0);
  const uoms = [...new Set(rows.map(r => r.uom).filter(Boolean))];

  return {
    date,
    product,
    lines: rows.length,
    /* Only meaningful when every line shares a unit — an all-items query
       mixes LTR, NOS and MT, and a combined total would be a number with no
       unit. Null is the honest answer there. */
    total_qty: uoms.length === 1 ? round(total, 2) : null,
    uom: uoms.length === 1 ? uoms[0] : null,
    uoms,
    by_department: sumBy('department'),
    by_analytic_account: sumBy('analytic_account'),
    rows: rows.map(r => ({
      issue_no: r.issue_no,
      mrq_no: r.mrq_no,
      product_code: r.product_code,
      product_name: r.product_name,
      uom: r.uom,
      department: r.department,
      division: r.division,
      analytic_account: r.analytic_account,
      equipment: r.equipment,
      qty: round(r.issued_quantity, 3),
      unit_cost: r.unit_cost === null ? null : round(r.unit_cost, 2),
      value_tzs: r.value === null ? null : round(r.value, 2),
    })),
  };
}

/* ── Freshness ─────────────────────────────────────────────────────── */

/* How current each table is. The reports show this so a reader can tell
   "zero trucks today" (a real quiet day) from "the sync has not run since
   Tuesday" — the fabricated-zero failure the 2026-09-30 audit named. */
async function freshness() {
  const { rows } = await db.query(
    `SELECT 'gate' AS feed, max(receipt_date)::text AS latest_day, max(synced_at) AS synced_at,
            count(*)::int AS rows FROM rm_gate_entries
     UNION ALL
     SELECT 'grn', max(grn_date::date)::text, max(synced_at), count(*)::int FROM rm_grn_lines
     UNION ALL
     SELECT 'issues', max(issue_day)::text, max(synced_at), count(*)::int FROM stores_issues`);
  return rows;
}

module.exports = {
  receiptsForDate,
  valuationForRange,
  pendingGrn,
  issuesForDate,
  freshness,
  COAL_VENDORS,
};
