/*
  services/salesRegister.js — Sales dashboard figures from the Sale Register
  mirror (migrations 034/035, filled by odooSalesSync.js).

  Basis: INVOICE DATE, cement only. That is how the Sales team's SALE
  REGISTER is built — reconciled for September 2026 invoice by invoice — so
  every tonnage, customer, division and money figure here is on the one
  basis the Sales team reconciles against. Non-cement invoices (fly ash,
  scrap) are excluded as the Register excludes them.

  Two known, labelled gaps versus the Register, both upstream:
    - credit notes are not in the feed (September: one, -30 MT);
    - "cash collected in the month" cannot be built from it — the feed only
      carries receipts applied to the invoices it returns, so receipts paying
      other months' invoices are invisible. Collection figures here are
      therefore "collected ON this period's invoices", and say so.

  Every function is pure SQL over the mirror. `coverage` says how many of the
  period's days have actually been synced, because a day with no invoices
  and a day never pulled look identical in odoo_sale_invoices.
*/
const db = require('../db');
const { SALES_GRADES } = require('../config/salesGrades');

const r1 = v => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const r0 = v => (v === null || v === undefined ? null : Math.round(Number(v)));

async function getRegisterPeriod(from, to, { today } = {}) {
  const p = [from, to];
  const [cov, tot, byDate, byGrade, byDateGrade, topCust, byZone, coll, ageing, payStatus] = await Promise.all([
    db.query(`SELECT sync_day::text AS d, synced_at FROM odoo_sale_sync_days
              WHERE sync_day BETWEEN $1 AND $2 ORDER BY 1`, p),
    db.query(`SELECT count(*)::int AS invoices,
                     count(DISTINCT customer_code)::int AS customers,
                     coalesce(sum(cement_mt), 0) AS mt,
                     coalesce(sum(untaxed_amount), 0) AS net,
                     coalesce(sum(excise_amount), 0) AS excise,
                     coalesce(sum(total_amount), 0) AS total
              FROM odoo_sale_invoices
              WHERE invoice_date BETWEEN $1 AND $2 AND is_cement`, p),
    db.query(`SELECT invoice_date::text AS d, sum(cement_mt) AS mt
              FROM odoo_sale_invoices WHERE invoice_date BETWEEN $1 AND $2 AND is_cement
              GROUP BY 1`, p),
    db.query(`SELECT coalesce(l.grade_key, 'other') AS g, sum(l.qty_mt) AS mt
              FROM odoo_sale_invoice_lines l JOIN odoo_sale_invoices i USING (invoice_id)
              WHERE i.invoice_date BETWEEN $1 AND $2 AND l.is_cement
              GROUP BY 1`, p),
    db.query(`SELECT i.invoice_date::text AS d, coalesce(l.grade_key, 'other') AS g, sum(l.qty_mt) AS mt
              FROM odoo_sale_invoice_lines l JOIN odoo_sale_invoices i USING (invoice_id)
              WHERE i.invoice_date BETWEEN $1 AND $2 AND l.is_cement
              GROUP BY 1, 2`, p),
    /* Grouped by customer_code (the Register's customer key); the name is
       the most recent one, since Odoo display names get edited. */
    db.query(`SELECT customer_code AS code,
                     (array_agg(customer_name ORDER BY invoice_date DESC))[1] AS name,
                     sum(cement_mt) AS mt, sum(untaxed_amount) AS net, count(*)::int AS invoices
              FROM odoo_sale_invoices WHERE invoice_date BETWEEN $1 AND $2 AND is_cement
              GROUP BY customer_code ORDER BY sum(cement_mt) DESC LIMIT 10`, p),
    db.query(`SELECT coalesce(division, '—') AS division, coalesce(zone, '—') AS zone,
                     sum(cement_mt) AS mt, count(*)::int AS invoices,
                     count(DISTINCT customer_code)::int AS customers
              FROM odoo_sale_invoices WHERE invoice_date BETWEEN $1 AND $2 AND is_cement
              GROUP BY 1, 2`, p),
    db.query(`SELECT coalesce(sum(total_amount), 0) AS invoiced,
                     coalesce(sum(residual_amount), 0) AS outstanding,
                     count(*) FILTER (WHERE residual_amount > 0)::int AS open_invoices
              FROM odoo_sale_invoices WHERE invoice_date BETWEEN $1 AND $2 AND is_cement`, p),
    /* Aged by INVOICE date: the feed has no due date. Same caveat the old
       endpoint carried, for the same reason. */
    db.query(`SELECT
                coalesce(sum(residual_amount) FILTER (WHERE $3::date - invoice_date <= 30), 0) AS d0_30,
                coalesce(sum(residual_amount) FILTER (WHERE $3::date - invoice_date BETWEEN 31 AND 60), 0) AS d31_60,
                coalesce(sum(residual_amount) FILTER (WHERE $3::date - invoice_date BETWEEN 61 AND 90), 0) AS d61_90,
                coalesce(sum(residual_amount) FILTER (WHERE $3::date - invoice_date BETWEEN 91 AND 120), 0) AS d91_120,
                coalesce(sum(residual_amount) FILTER (WHERE $3::date - invoice_date > 120), 0) AS older,
                count(*)::int AS invoice_count
              FROM odoo_sale_invoices
              WHERE invoice_date BETWEEN $1 AND $2 AND is_cement AND residual_amount > 0`,
      [from, to, today || to]),
    db.query(`SELECT payment_status AS s, count(*)::int AS n, coalesce(sum(residual_amount), 0) AS outstanding
              FROM odoo_sale_invoices WHERE invoice_date BETWEEN $1 AND $2 AND is_cement
              GROUP BY 1`, p),
  ]);

  const t = tot.rows[0];
  const mt = Number(t.mt);
  const net = Number(t.net), excise = Number(t.excise);

  const gradeMt = Object.fromEntries(byGrade.rows.map(r => [r.g, Number(r.mt)]));

  const dayGrades = {};
  for (const r of byDateGrade.rows) {
    dayGrades[r.d] = dayGrades[r.d] || {};
    dayGrades[r.d][r.g] = r1(r.mt);
  }

  const zones = byZone.rows.map(r => ({
    division: r.division, zone: r.zone, mt: r1(r.mt), invoices: r.invoices, customers: r.customers,
  }));
  const divisions = new Map();
  for (const z of zones) {
    const d = divisions.get(z.division) || { division: z.division, mt: 0, invoices: 0 };
    d.mt += z.mt; d.invoices += z.invoices; divisions.set(z.division, d);
  }

  const c = coll.rows[0];
  const invoiced = Number(c.invoiced), outstanding = Number(c.outstanding);

  return {
    coverage: {
      days_synced: cov.rows.length,
      synced_days: cov.rows.map(r => r.d),
      last_synced: cov.rows.reduce((m, r) => (!m || r.synced_at > m ? r.synced_at : m), null),
    },
    invoices: t.invoices,
    customers: t.customers,
    mt: r1(mt),
    net_tzs: r0(net),
    excise_tzs: r0(excise),
    total_tzs: r0(t.total),
    /* Net of VAT and excise, per tonne. Freight is still inside it (the feed
       does not split freight out), so this is NOT the Register's NCR. */
    price_per_mt_tzs: mt ? r0((net - excise) / mt) : null,
    by_date: Object.fromEntries(byDate.rows.map(r => [r.d, r1(r.mt)])),
    by_grade: Object.fromEntries([...SALES_GRADES.map(g => g.key), 'other'].map(k => [k, r1(gradeMt[k] || 0)])),
    by_date_grade: dayGrades,
    top_customers: topCust.rows.map(r => ({
      code: r.code, name: r.name, mt: r1(r.mt), net_tzs: r0(r.net), invoices: r.invoices,
    })),
    by_zone: zones.sort((a, b) => a.division.localeCompare(b.division) || b.mt - a.mt),
    by_division: [...divisions.values()].map(d => ({ ...d, mt: r1(d.mt) }))
      .sort((a, b) => a.division.localeCompare(b.division)),
    collections: {
      invoice_count: t.invoices,
      invoiced_tzs: r0(invoiced),
      /* Derived from the two ROUNDED figures, so collected + outstanding ==
         invoiced exactly on the page (rounding each separately left it 1 TZS
         short in October). */
      total_collected_tzs: r0(invoiced) - r0(outstanding),
      outstanding_tzs: r0(outstanding),
      open_invoices: c.open_invoices,
      collection_rate_pct: invoiced ? r1((invoiced - outstanding) / invoiced * 100) : null,
      by_payment_status: Object.fromEntries(payStatus.rows.map(r => [r.s || 'unknown', { invoices: r.n, outstanding_tzs: r0(r.outstanding) }])),
    },
    ageing: {
      d0_30: r0(ageing.rows[0].d0_30), d31_60: r0(ageing.rows[0].d31_60), d61_90: r0(ageing.rows[0].d61_90),
      d91_120: r0(ageing.rows[0].d91_120), older: r0(ageing.rows[0].older),
      invoice_count: ageing.rows[0].invoice_count,
    },
  };
}

module.exports = { getRegisterPeriod };
