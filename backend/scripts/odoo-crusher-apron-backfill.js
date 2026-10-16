/*
  scripts/odoo-crusher-apron-backfill.js — puts crusher apron-feeder hours
  (fact ls_crusher_apron_hrs, migration 040) onto production reports that
  ALREADY EXIST, without running the general production autofill over the
  same range. Re-runnable: a second run finds nothing blank and writes nothing.

  Usage:
    node scripts/odoo-crusher-apron-backfill.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run] [--no-pull]
    node scripts/odoo-crusher-apron-backfill.js 2026-04-01 2026-10-15

  Step 1 re-pulls Odoo's production_report for the range into the mirror
  (odoo_production_entries) so the crusher entries carry apron hours. Skip it
  with --no-pull if the mirror is already current. --dry-run implies
  --no-pull, reads the mirror as it stands, and writes nothing at all.

  ── Why not just `odoo-production-sync.js <range>` ──────────────────────
  The general autofill writes EVERY Odoo-owned fact and, by decision A, makes
  Odoo's value win over whatever the report holds. Dry-run over
  2026-04-01..2026-10-15 on the dev DB (2026-10-15), after the re-pull, it
  would have:
    - overwritten the plant's own Excel crusher tonnage on 50 Apr-Jun days
      and crusher running hours on 26, plus 70 other Apr-Jun values (clinker,
      gypsum and limestone consumption, kiln and coal-mill hours, …);
    - filled cm1_425n_bm_mt on 76 and cm2_opc_mt on 83 Apr-Jun days, which
      moves the cement-produced-day KPI for months the registry documents
      as unchanged;
    - filled kiln/coal-mill running hours and coal NCV for Jul-Sep.
  Some of that may well be wanted, but none of it is the apron-hours change,
  and the overrides replace human-entered figures. So this writes ONLY the
  three crusher facts, ONLY into blanks, on ONLY existing reports.

  ── What it writes, per existing production report (shift 'day') ───────
    ls_crusher_prod_mt, ls_crusher_run_hrs — Odoo's value, only where the
      report has none (Jul-Sep on the dev DB: the crusher group only reached
      the mirror on 2026-10-08 and older days were never re-pulled).
    ls_crusher_apron_hrs — Odoo's value, only where the report has none AND
      the report's crusher tonnage is Odoo's own Crusher Production Entry
      tonnage (within 0.005 t, the autofill's own equality tolerance).

  The second condition is the important one. TPH = tonnage ÷ apron hours, so
  the two must describe the same crushing. Apr-Jun reports carry the plant's
  Excel tonnage, which disagrees with the Crusher Production Entry by more
  than 1% on 46 of the 85 days both exist (May: +6.2% for the month;
  2026-05-01 reads 9,628 t against Odoo's 2,696 t). Dividing Excel tonnage by
  Odoo apron hours there would print a TPH neither source supports (May would
  read 205.7 instead of 193.8, single days several hundred t/h). Those days
  are left without apron hours, so their TPH stays blank, and are listed in
  the output for a decision — they are not silently "fixed".

  Never: overrides a stored value, creates a report, or touches status /
  approved_by / approved_at. Each changed day gets one ODOO_AUTOFILL row in
  report_revisions (actor 'odoo-sync', actor_id NULL), the same audit trail
  services/odooProductionAutofill.js writes.
*/

const FORM_TYPE = 'production';
const SHIFT     = 'day';
const TOLERANCE = 0.005;   // = EQUAL_TOLERANCE in services/odooProductionAutofill.js
const FILL_IF_BLANK = ['ls_crusher_prod_mt', 'ls_crusher_run_hrs'];
const APRON = 'ls_crusher_apron_hrs';

function asNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Pure — the whole decision for one day, unit-tested in
   test/odoo-production.test.js. existing: the report's stored `data`;
   odooFacts: mapDay(...).facts for that day. Returns the fields to write and,
   when apron hours were withheld, why. */
function planDay(existing, odooFacts) {
  const data = existing || {};
  const write = {};
  for (const f of FILL_IF_BLANK) {
    if (f in odooFacts && asNumber(data[f]) === null) write[f] = odooFacts[f];
  }

  let withheld = null;
  if (APRON in odooFacts && asNumber(data[APRON]) === null) {
    const reportTonnage = 'ls_crusher_prod_mt' in write ? write.ls_crusher_prod_mt : asNumber(data.ls_crusher_prod_mt);
    const odooTonnage   = asNumber(odooFacts.ls_crusher_prod_mt);
    if (reportTonnage !== null && odooTonnage !== null && Math.abs(reportTonnage - odooTonnage) <= TOLERANCE) {
      write[APRON] = odooFacts[APRON];
    } else {
      withheld = { reportTonnage, odooTonnage, apron: odooFacts[APRON] };
    }
  }
  return { write, withheld };
}

/* One day, one transaction, decided under the row lock so a value a person
   saves concurrently can never be overwritten by a decision made on a stale
   read. */
async function applyDay(db, recordRevision, date, odooFacts, refs, { dryRun }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT data, status, approved_by, approved_at
       FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
      [FORM_TYPE, date, SHIFT]);
    const row = rows[0];
    if (!row) { await client.query('ROLLBACK'); return { action: 'no_report' }; }

    const { write, withheld } = planDay(row.data, odooFacts);
    const fields = Object.keys(write).sort();
    if (!fields.length || dryRun) {
      await client.query('ROLLBACK');
      return { action: fields.length ? 'would_fill' : 'unchanged', write, withheld };
    }

    await client.query(
      `UPDATE daily_reports SET data = data || $4::jsonb, updated_at = NOW()
       WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
      [FORM_TYPE, date, SHIFT, JSON.stringify(write)]);
    await recordRevision(client, {
      formType: FORM_TYPE, recordDate: date, shift: SHIFT, action: 'ODOO_AUTOFILL',
      priorData: row.data, priorStatus: row.status,
      priorApprovedBy: row.approved_by, priorApprovedAt: row.approved_at,
      changedFields: fields, actorId: null, actorName: 'odoo-sync',
      reason: `Crusher apron-hours backfill (migration 040), blanks only. Odoo entries: ${refs.join(',') || 'none'}`,
    });
    await client.query('COMMIT');
    return { action: 'filled', write, withheld };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is what matters */ });
    throw err;
  } finally {
    client.release();
  }
}

async function main(from, to, { dryRun, noPull }) {
  require('../config/env');
  const db = require('../db');
  const { recordRevision } = require('../services/reportRevisions');
  const { pullProductionEntries, loadRangeFacts } = require('../services/odooProductionSync');

  try {
    if (!dryRun && !noPull) {
      const pull = await pullProductionEntries(from, to);
      console.log('PULL ' + JSON.stringify({ received: pull.received, added: pull.added, updated: pull.updated,
        unchanged: pull.unchanged, withdrawn: pull.withdrawn, rejected: pull.rejected, sweepsSkipped: pull.sweepsSkipped }));
    }

    const byDay = await loadRangeFacts(from, to);
    const summary = { from, to, dryRun, days: 0, filled: 0, noReport: [], byField: {}, withheld: [] };
    for (const date of Object.keys(byDay).sort()) {
      const facts = byDay[date].facts;
      const odooFacts = {};
      for (const k of [...FILL_IF_BLANK, APRON]) if (k in facts) odooFacts[k] = facts[k];
      if (!Object.keys(odooFacts).length) continue;   // no crusher entry that day
      summary.days++;

      const refs = byDay[date].refs.filter(r => /^CRU\//.test(r));
      const r = await applyDay(db, recordRevision, date, odooFacts, refs, { dryRun });
      if (r.action === 'no_report') { summary.noReport.push(date); continue; }
      if (r.action === 'filled' || r.action === 'would_fill') summary.filled++;
      for (const f of Object.keys(r.write || {})) {
        const m = date.slice(0, 7);
        ((summary.byField[f] ||= {})[m] = (summary.byField[f][m] || 0) + 1);
      }
      if (r.withheld) summary.withheld.push({ date, ...r.withheld });
    }

    console.log('CRUSHER_APRON_BACKFILL ' + JSON.stringify(summary, null, 2));
    if (summary.withheld.length) {
      console.log(`\nNOTE: apron hours were withheld on ${summary.withheld.length} day(s) because the report's crusher `
        + 'tonnage is not the Crusher Production Entry\'s, so their TPH stays blank. Deciding whether Odoo\'s tonnage '
        + 'should replace the stored figure on those days is a business decision; nothing was overwritten.');
    }
    if (summary.noReport.length) {
      console.log(`\nNOTE: ${summary.noReport.length} day(s) have crusher data in Odoo but no production report yet `
        + `(${summary.noReport.join(', ')}). The scheduled production autofill creates those; this script does not.`);
    }
  } finally {
    await db.end().catch(() => { /* already closed */ });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noPull = args.includes('--no-pull');
  const [from, to] = args.filter(a => !a.startsWith('--'));
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !ISO.test(from) || !ISO.test(to) || from > to) {
    console.error('Usage: node scripts/odoo-crusher-apron-backfill.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run] [--no-pull]');
    process.exitCode = 1;
  } else {
    /* No process.exit(): see odoo-production-pull.js — pino's exit hook can
       stall and turn a completed run into a reported failure. */
    main(from, to, { dryRun, noPull }).catch(err => {
      console.error('CRUSHER_APRON_BACKFILL_FAILED ' + err.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { planDay, TOLERANCE };
