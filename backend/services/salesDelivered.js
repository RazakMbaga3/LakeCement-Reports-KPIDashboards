/*
  services/salesDelivered.js — DELIVERED sales tonnage, the figure the
  Sales Register reports.

  ── Why this exists ────────────────────────────────────────────────────
  The Sales dashboard used to total `sale_order_lines` from
  sale_dashboard_report. That is tonnage ORDERED, which is not what the
  business calls sales. Reconciled against the Sales team's own
  "SEP SALE REGISTER" for September 2026 (Grand MT 59,548.76):

      Sale Register (delivery notes)   59,548.76 MT
      sale_order_lines                 60,764.1  MT   (+1,215.3, +2.0%)

  The cause is timing, not bad data. Grouping the Register's own rows by
  DN date puts 59,085.9 MT in September; grouping the SAME rows by SO date
  spreads them across June (46.0), July (100.0), August (5,113.1) and
  September (54,289.6). Orders booked in one month ship in the next, so an
  order-date total misplaces tonnage in both directions.

  Odoo's dispatch_report, which this app already syncs every 30 minutes
  into daily_reports (form_type='dispatch', see odooDispatchSync.js),
  matches the Register almost exactly for the same month:

      grade               Register    dispatch    diff
      CEMENT 42.5 R        43,769.9    43,769.9     0.0
      CEMENT B-M 42.5 N     9,633.5     9,633.5     0.0
      CEMENT OPC 42.5 N       995.4       995.4     0.0
      CEMENT 32.5           5,150.0     5,180.0   +30.0
      cement total         59,548.8    59,578.8   +30.0  (0.05%)

  Three of four grades to the decimal. The 30 MT on 32.5 is most likely a
  delivery note on the month boundary; it is queried in
  docs/email-drafts/04-odoo-sales-register-api-request.md and is NOT
  silently corrected here.

  ── Why it reads daily_reports and not Odoo ────────────────────────────
  odooDispatchSync.js already pulls dispatch_report on a 30-minute cron
  and writes per-day, per-channel, per-grade MT into daily_reports. Going
  back to Odoo here would add a second live call to every dashboard load
  (sale_dashboard_report alone is 8-15 s/month on production) for data we
  already hold. This reads what the sync wrote.

  ── What this deliberately does NOT provide ────────────────────────────
  Customer, division, zone and officer. dispatch_report carries none of
  them — only (date, grade, channel, MT). Officer Achievement, Top
  Customers and Active Customers therefore stay on sale-order data and are
  labelled as ordered-basis in the UI, until the Sale Register endpoint
  requested in docs/email-drafts/04-… lands. Inventing an attribution here
  would be a guess, and the whole point of this change is to stop
  reporting a number the Sales team cannot reconcile.
*/
const db = require('../db');
const { SALES_GRADES } = require('../config/salesGrades');

/* dispatch field suffix -> sales grade key. The suffixes come from
   odooDispatchSync.js's GRADE_SUFFIX (its own mapping of Odoo's
   product_grade strings); this maps those onto the four marketing lines
   the Sales dashboard reports in.

   425nbm -> duramax42 is the equivalence that has flipped twice in this
   codebase: Duramax 42 (product FG005) IS the plant's "42.5 N B-M" grade,
   marketing name vs plant name for one product. odooDispatchSync.js's
   header documents both confirmations; config/odooProductionMap.js has
   always agreed. The September Register is a third: its CEMENT B-M 42.5 N
   total (9,633.5) matches dispatch's 425nbm exactly.

   425n (plain "CEMENT 42.5 N") maps to NO sales grade on purpose. It is a
   real dispatch field, but the Sales dashboard has no product line for it
   and the September Register carried no such rows. Folding it into
   another grade would overstate that grade, so its tonnage lands in
   `other_mt` below, visible rather than hidden. */
const SUFFIX_TO_GRADE = {
  '425r':    'super42',
  '325n':    'max32',
  '425nbm':  'duramax42',
  'opc425n': 'premiumopc',
};

const CHANNELS = ['reg', 'blk', 'bag'];

/* Pull every dispatch_* quantity for [from, to] out of daily_reports and
   fold it into per-day, per-grade and per-channel totals.

   Non-cement (SCRAP STEEL, FLY ASH, VEHICLE SOLD) never appears here:
   odooDispatchSync.js skips it at write time, so nothing in daily_reports
   carries it. That matches the Register, which is cement-only. */
async function getDeliveredTonnage(from, to) {
  const result = await db.query(
    `SELECT record_date, data FROM daily_reports
     WHERE form_type = 'dispatch' AND record_date BETWEEN $1 AND $2
     ORDER BY record_date`,
    [from, to]
  );

  const byDate = {};
  const byGrade = Object.fromEntries(SALES_GRADES.map(g => [g.key, 0]));
  const byChannel = { reg: 0, blk: 0, bag: 0 };
  let total = 0;
  let otherMt = 0;      // mapped dispatch fields with no Sales grade (425n)
  let daysWithData = 0;

  for (const row of result.rows) {
    const data = row.data || {};
    const dateKey = String(row.record_date).slice(0, 10);
    let dayTotal = 0;
    const dayGrades = Object.fromEntries(SALES_GRADES.map(g => [g.key, 0]));

    for (const channel of CHANNELS) {
      for (const [suffix, gradeKey] of Object.entries(SUFFIX_TO_GRADE)) {
        const v = Number(data[`dispatch_${channel}_${suffix}`]);
        if (!Number.isFinite(v) || v === 0) continue;
        dayTotal += v;
        dayGrades[gradeKey] += v;
        byGrade[gradeKey] += v;
        byChannel[channel] += v;
        total += v;
      }
      /* 425n has no sales grade — counted into the day/total so the
         headline still reconciles against the Register, but kept out of
         the grade mix rather than misfiled into a neighbouring grade. */
      const plain = Number(data[`dispatch_${channel}_425n`]);
      if (Number.isFinite(plain) && plain !== 0) {
        dayTotal += plain;
        byChannel[channel] += plain;
        otherMt += plain;
        total += plain;
      }
    }

    if (dayTotal !== 0) daysWithData++;
    byDate[dateKey] = {
      date: dateKey,
      mt: Math.round(dayTotal * 10) / 10,
      ...Object.fromEntries(Object.entries(dayGrades).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    };
  }

  return {
    total_mt: Math.round(total * 10) / 10,
    by_grade: Object.fromEntries(Object.entries(byGrade).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    by_channel: Object.fromEntries(Object.entries(byChannel).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    other_mt: Math.round(otherMt * 10) / 10,
    by_date: byDate,
    days_with_data: daysWithData,
  };
}

module.exports = { getDeliveredTonnage, SUFFIX_TO_GRADE };
