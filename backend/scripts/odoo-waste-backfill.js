/*
  scripts/odoo-waste-backfill.js — one-off (and safely repeatable) load of
  Odoo's whole Waste Material Entry history (overburden) into
  odoo_waste_material_entries. The live job keeps the last 21 days current
  after that; see services/odooWasteSync.js.

  Usage:
    node scripts/odoo-waste-backfill.js                 # all history → today
    node scripts/odoo-waste-backfill.js 2026-04-01 2026-10-15
    npm run odoo:waste-backfill

  Idempotent: an upsert by Odoo id. Prints the checks this feed was
  verified against on 2026-10-15 so a re-run proves the mirror still agrees.

  Requires ODOO_PG_* (services/odooDb.js); `npm run odoo:db-test` checks it.
*/
require('../config/env');
const db = require('../db');
const { pullWasteEntries } = require('../services/odooWasteSync');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const today = new Date().toISOString().slice(0, 10);
/* Odoo's history starts 2022-11/12; 2022-01-01 is a safe floor. */
const [from, to] = args.length ? args : ['2022-01-01', today];
if (!ISO.test(from) || !ISO.test(to) || from > to) {
  console.error('Usage: node scripts/odoo-waste-backfill.js [<from YYYY-MM-DD> <to YYYY-MM-DD>]');
  process.exit(1);
}

async function check(label, sql, params) {
  const { rows: [r] } = await db.query(sql, params);
  console.log(`  ${label}: ${JSON.stringify(r)}`);
}

(async () => {
  try {
    const result = await pullWasteEntries(from, to);
    console.log('WASTE_BACKFILL_RESULT ' + JSON.stringify(result, null, 2));
    if (result.skipped) {
      console.log(`\nSKIPPED — ${result.skipped}. Set ODOO_PG_* in backend/.env.`);
      return;
    }
    console.log('\nChecks (approved entries only, as every reader counts them):');
    await check('2026-09-26 entries', `
      SELECT string_agg(name || ' ' || contractor || ' ' || trips || ' trips ' || quantity_mt::float8 || ' t', ' + ' ORDER BY name) AS entries
        FROM odoo_waste_material_entries
       WHERE entry_date = '2026-09-26' AND state = 'approved' AND withdrawn_at IS NULL`);
    await check('Sep 2026 total', `
      SELECT SUM(quantity_mt)::float8 AS mt, SUM(trips)::int AS trips FROM odoo_waste_material_entries
       WHERE entry_date BETWEEN '2026-09-01' AND '2026-09-30' AND state = 'approved' AND withdrawn_at IS NULL`);
    await check('1-12 Oct 2026 total', `
      SELECT SUM(quantity_mt)::float8 AS mt, SUM(trips)::int AS trips FROM odoo_waste_material_entries
       WHERE entry_date BETWEEN '2026-10-01' AND '2026-10-12' AND state = 'approved' AND withdrawn_at IS NULL`);
    await check('stored by state', `
      SELECT json_object_agg(state, n) AS by_state FROM
        (SELECT state, COUNT(*) AS n FROM odoo_waste_material_entries WHERE withdrawn_at IS NULL GROUP BY state) s`);
  } catch (err) {
    console.error('WASTE_BACKFILL_FAILED ' + err.message);
    process.exitCode = 1;
  } finally {
    await require('../services/odooDb').close().catch(() => { /* already closed */ });
    await db.end().catch(() => { /* already closed */ });
  }
})();
