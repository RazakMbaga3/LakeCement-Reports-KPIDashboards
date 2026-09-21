/*
  scripts/odoo-production-sync.js — Phase 3: pull production_report AND
  write it into daily_reports (form_type='production'). Phase 1's own
  `odoo-production-pull.js` only refreshes the mirror; this is the one that
  makes an officer's form actually show Odoo's numbers.

  Usage:
    node scripts/odoo-production-sync.js <from YYYY-MM-DD> <to YYYY-MM-DD>
    node scripts/odoo-production-sync.js 2026-09-01 2026-09-20
    node scripts/odoo-production-sync.js 2026-09-01 2026-09-20 --dry-run

  --dry-run reports exactly what would change (days created as drafts, days
  updated, overrides logged) without writing anything — every query still
  runs, the transaction is just rolled back. Use it before trusting a first
  run against a new range.

  New days land as DRAFT reports (decision B) — an officer still has to
  open one, add what Odoo cannot supply, and submit it for HOD approval.
  A day that already has a report gets its Odoo-owned fields corrected in
  place if they differ (decision A); the report's status is never touched,
  so this cannot silently "re-approve" anything.

  Requires ODOO_PRODUCTION_URL + ODOO_PRODUCTION_API_KEY — see
  services/odooProductionClient.js.
*/
require('../config/env');
const { pullAndAutofillProduction } = require('../services/odooProductionAutofill');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [from, to] = args.filter(a => !a.startsWith('--'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
if (!from || !to || !ISO.test(from) || !ISO.test(to)) {
  console.error('Usage: node scripts/odoo-production-sync.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]');
  process.exit(1);
}
if (from > to) {
  console.error(`Empty range: from (${from}) is after to (${to}).`);
  process.exit(1);
}

/* No process.exit() past this point — see odoo-production-pull.js's own
   note: pino's exit hook can stall flushing its log worker and turn a
   completed run into a reported failure. db.end() drains the pool and lets
   the event loop exit on its own. This script always touches the database
   (even --dry-run reads inside a rolled-back transaction), unlike the pull
   script's dry-run, so the pool close is unconditional here. */
(async () => {
  try {
    const result = await pullAndAutofillProduction(from, to, { dryRun });
    console.log('PRODUCTION_SYNC_RESULT ' + JSON.stringify(result, null, 2));

    const a = result.autofill;
    if (dryRun) {
      console.log(`\nDRY RUN — nothing was written. Would create ${a.created} draft(s), `
        + `update ${a.updated} existing day(s), touch ${a.fieldsWritten} field(s) `
        + `(${a.overrides} of them overriding an already-stored value).`);
    } else if (a.overrides) {
      console.log(`\nNOTE: ${a.overrides} field(s) across ${a.overrideDays.length} day(s) had a stored `
        + 'value that disagreed with Odoo and were corrected. See production_odoo_overrides for detail, '
        + 'or the days listed above under autofill.overrideDays.');
    }
  } catch (err) {
    console.error('PRODUCTION_SYNC_FAILED ' + err.message);
    process.exitCode = 1;
  } finally {
    await require('../db').end().catch(() => { /* already closed */ });
  }
})();
