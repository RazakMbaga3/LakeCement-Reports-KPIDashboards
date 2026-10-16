/*
  scripts/odoo-materials-sync.js — pull the Odoo Stores feed AND write it
  into daily_reports (form_type='materials'), so the Raw Material Report
  shows the day's receipts without anyone opening the form.

  `odoo-stores-backfill.js` only refreshes the three mirror tables; this is
  the one that makes the report itself read live.

  Usage:
    node scripts/odoo-materials-sync.js <from YYYY-MM-DD> <to YYYY-MM-DD>
    node scripts/odoo-materials-sync.js 2026-09-01 2026-10-07
    node scripts/odoo-materials-sync.js 2026-09-01 2026-10-07 --dry-run
    node scripts/odoo-materials-sync.js 2026-09-01 2026-10-07 --no-pull

  --dry-run  reports exactly what would change without writing: every query
             still runs, the transaction is just rolled back.
  --no-pull  skips the Odoo call and reconciles only what is already in
             Postgres. The pull is the expensive part (~33 s for a 7-day
             window against an ERP that also serves the plant's own users),
             so a re-reconcile of a range just pulled should not pay it
             twice. Backfilling a long range: run odoo-stores-backfill.js
             first (it chunks the pull a week at a time), then this with
             --no-pull.

  New days land as 'pending_approval', not 'draft' — these receipts are
  already approved in Odoo before the API returns them, and 'draft' is not
  in REPORTED_STATUSES, so a drafted day would read as "No data" over real
  tonnage. Nothing here is ever marked 'approved'.

  Odoo fills RECEIVED and PENDING GRN only. Consumption is read off plant
  meters and never passes through Odoo, so it stays the officer's to enter
  — and until they do, that day's closing stock is provisional.

  Requires the ODOO stores credentials — see services/odooStoresClient.js.
*/
require('../config/env');
const {
  pullAndAutofillMaterials, syncMaterialsRangeToReports,
} = require('../services/odooMaterialsAutofill');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noPull = args.includes('--no-pull');
const [from, to] = args.filter(a => !a.startsWith('--'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
if (!from || !to || !ISO.test(from) || !ISO.test(to)) {
  console.error('Usage: node scripts/odoo-materials-sync.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run] [--no-pull]');
  process.exit(1);
}
if (from > to) {
  console.error(`Empty range: from (${from}) is after to (${to}).`);
  process.exit(1);
}

/* No process.exit() past this point — pino's exit hook can stall flushing
   its log worker and turn a completed run into a reported failure. db.end()
   drains the pool and lets the event loop exit on its own. */
(async () => {
  try {
    const result = noPull
      ? { autofill: await syncMaterialsRangeToReports(from, to, { dryRun }) }
      : await pullAndAutofillMaterials(from, to, { dryRun });
    console.log('MATERIALS_SYNC_RESULT ' + JSON.stringify(result, null, 2));

    const a = result.autofill;
    if (dryRun) {
      console.log(`\nDRY RUN — nothing was written. Would create ${a.created} day(s) as `
        + `approved (unsigned), update ${a.updated} existing day(s), and touch `
        + `${a.fieldsWritten} field(s).`);
    }
    /* Both of these mean a printed number is knowably incomplete. Saying so
       on stdout matters because a backfill is usually watched by a person
       who will never read the log file. */
    if (a.conflicts) {
      console.log(`\nNOTE: ${a.conflicts} figure(s) across ${a.conflictDays.length} day(s) disagree with `
        + 'what is already stored. The stored (officer-entered) value was KEPT — nothing was overwritten. '
        + 'See autofill.conflictDays above to reconcile them.');
    }
    if (a.unassignedDays.length) {
      console.log(`\nWARNING: ${a.unassignedDays.length} day(s) had trucks that could not be matched to a `
        + 'report row, so their tonnage is NOT on the report. Map the supplier or item code in '
        + 'config/odooMaterialMap.js — see autofill.unassignedDays above.');
    }
  } catch (err) {
    console.error('MATERIALS_SYNC_FAILED ' + err.message);
    process.exitCode = 1;
  } finally {
    await require('../db').end().catch(() => { /* already closed */ });
  }
})();
