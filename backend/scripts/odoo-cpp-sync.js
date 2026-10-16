/*
  scripts/odoo-cpp-sync.js — read Odoo's Captive Power Plant entries
  (cpp_entry, over the read-only database login) and write them into the
  CPP daily report (daily_reports, form_type='cpp').

  Usage:
    node scripts/odoo-cpp-sync.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]
    node scripts/odoo-cpp-sync.js 2026-09-21 2026-10-15
    npm run odoo:cpp-sync -- 2026-09-21 2026-10-15 --dry-run

  --dry-run reports exactly what would change without writing anything —
  every query still runs, each day's transaction is rolled back.

  A day nobody has a report for is created 'approved' with approved_by NULL
  (decision B″, as for the Production and Raw Material autofills). A day a
  person has entered or touched is never written; if Odoo disagrees with it,
  the difference is listed under humanDayDifferences and left alone. The
  field mapping and its evidence: config/odooCppMap.js.

  Requires ODOO_PG_HOST / ODOO_PG_USER / ODOO_PG_DATABASE (+ password) —
  see services/odooDb.js; `npm run odoo:db-test` checks the connection.
*/
require('../config/env');
const { pullAndAutofillCpp } = require('../services/odooCppAutofill');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [from, to] = args.filter(a => !a.startsWith('--'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
if (!from || !to || !ISO.test(from) || !ISO.test(to)) {
  console.error('Usage: node scripts/odoo-cpp-sync.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]');
  process.exit(1);
}
if (from > to) {
  console.error(`Empty range: from (${from}) is after to (${to}).`);
  process.exit(1);
}

/* No process.exit() past this point (see odoo-production-sync.js): close
   both pools and let the event loop end on its own. */
(async () => {
  try {
    const result = await pullAndAutofillCpp(from, to, { dryRun });
    console.log('CPP_SYNC_RESULT ' + JSON.stringify(result, null, 2));
    if (result.skipped) {
      console.log(`\nSKIPPED — ${result.skipped}. Set ODOO_PG_* in backend/.env.`);
    } else {
      const a = result.autofill;
      console.log(`\n${dryRun ? 'DRY RUN — nothing was written. Would create' : 'Created'} ${a.created} day(s), `
        + `${dryRun ? 'would update' : 'updated'} ${a.updated}, unchanged ${a.unchanged}, `
        + `left ${a.humanDays} person-entered day(s) alone, skipped ${a.emptyEntries} empty entr(ies) `
        + `and ${a.ambiguousDays.length} ambiguous date(s); ${a.fieldsWritten} field(s).`);
    }
  } catch (err) {
    console.error('CPP_SYNC_FAILED ' + err.message);
    process.exitCode = 1;
  } finally {
    await require('../services/odooDb').close().catch(() => { /* already closed */ });
    await require('../db').end().catch(() => { /* already closed */ });
  }
})();
