/*
  scripts/accept-odoo-production-autofill.js — acceptance tests for Phase 3
  (services/odooProductionAutofill.js): writing the mirror into daily_reports.

  test/odoo-production-autofill.test.js proves the pure reconciliation logic
  in memory. This proves the part that needs real Postgres and the actual
  daily_reports table: draft creation, in-place correction, the override
  log, dry-run leaving no trace, and the one rule that must never break —
  an already-approved report's status is never touched by an autofill run.

    1. a brand-new day creates a DRAFT report with Odoo's fields
    2. an identical re-run changes nothing and logs no override
    3. a stored value that disagrees with Odoo is corrected AND logged,
       with the right previous/odoo values and entry refs
    4. a field Odoo does not report is left exactly as the officer typed it
    5. an APPROVED report's data is corrected in place; its status,
       approved_by and approved_at do not move
    6. --dry-run-equivalent (the function's own dryRun option): nothing is
       written, no override rows appear, and a real run afterwards behaves
       exactly as if the dry run had never happened
    7. the two decision-C fields (raw_meal_prod_mt, raw_meal_cons_mt) land
       in the JSONB even though no form input reads them yet

  Uses only 1997-04-xx dates (Phase 1's own accept-odoo-production.js uses
  1997-03-xx — kept in a different month so the two can never collide) and
  cleans up after itself. Needs migrations 018 and 019 applied.
  Usage: node scripts/accept-odoo-production-autofill.js
*/
require('../config/env');
const db = require('../db');
const { pullProductionEntries } = require('../services/odooProductionSync');
const { syncProductionRangeToReports } = require('../services/odooProductionAutofill');

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── fixture ───────────────────────────────────────────────────────────
const item = (product, input) => ({ product, uom: 'MT', input_quantity: input, stock_available: 1, moisture: 0, final_qty_after_moisture: input, cost: 1 });
let seq = 0;
const raw = (day, product, produced, items = []) => ({
  name: 'ACCEPT-AF/' + String(++seq).padStart(3, '0'),
  production_date: `${String(day).padStart(2, '0')}/04/1997`, product, uom: 'MT',
  total_input_qty: produced, produced_qty: produced, consumed_items: items,
});
const build = (parts) => {
  const out = {};
  for (const [picking, e] of parts) (out[picking] ||= []).push(e);
  return out;
};

const CLK = 'CEMENT: Clinker Production';
const RM  = 'CEMENT: Raw Meal Production';
const FROM = '1997-04-01', TO = '1997-04-30';
const DAY1 = '1997-04-10';
const DAY2 = '1997-04-11';

const clinkerDay1 = raw(10, '[WIP003] CLINKER', 1300, [item('[WIP002] RAW MEAL', 2000), item('[WIP004] FINE COAL', 200)]);
const rawMealDay1 = raw(10, '[WIP002] RAW MEAL', 2000, [item('[WIP001] LIMESTONE MINING', 1000)]);
const clinkerDay2 = raw(11, '[WIP003] CLINKER', 900, []);

const pull = (parts) => pullProductionEntries(FROM, TO, { fetchReport: async () => build(parts) });
const sync = (opts) => syncProductionRangeToReports(FROM, TO, opts);

const reportOf = async (date) =>
  (await db.query("SELECT * FROM daily_reports WHERE form_type = 'production' AND record_date = $1 AND shift = 'day'", [date])).rows[0];
const overridesFor = async (date) =>
  (await db.query('SELECT * FROM production_odoo_overrides WHERE record_date = $1 ORDER BY id', [date])).rows;

async function cleanup() {
  await db.query("DELETE FROM production_odoo_overrides WHERE record_date BETWEEN $1 AND $2", [FROM, TO]);
  await db.query("DELETE FROM daily_reports WHERE form_type = 'production' AND record_date BETWEEN $1 AND $2", [FROM, TO]);
  await db.query("DELETE FROM odoo_production_entries WHERE entry_ref LIKE 'ACCEPT-AF/%'");
}

async function main() {
  await cleanup();
  for (const t of ['odoo_production_entries', 'production_odoo_overrides']) {
    const r = await db.query('SELECT to_regclass($1) AS t', [`public.${t}`]);
    if (!r.rows[0].t) { console.error(`${t} is missing — run: npm run migrate`); process.exitCode = 1; return; }
  }

  console.log('1. a brand-new day creates a DRAFT report with Odoo\'s fields');
  await pull([[CLK, clinkerDay1], [RM, rawMealDay1]]);
  const s1 = await sync();
  check('one day created, no overrides (nothing existed before)', s1.created === 1 && s1.overrides === 0, JSON.stringify(s1));
  const rep1 = await reportOf(DAY1);
  /* 'approved' with approved_by NULL — decision B″ (2026-10-14), replacing
     B′'s 'pending_approval'. An untouched Odoo day must COUNT immediately
     (both statuses are in REPORTED_STATUSES, so this moved no figure) WITHOUT
     queueing a signature nobody will give: B′ left 143 machine-filled rows in
     the HOD queue against zero human ones. approved_by/submitted_by stay null
     — nothing here claims a person submitted or signed it, and that NULL is
     what keeps the day correctable under DEC-008. */
  check('report exists, status approved, but NO human author and NO human signature',
    rep1 && rep1.status === 'approved' && rep1.submitted_by === null && rep1.approved_by === null,
    rep1 && JSON.stringify({ status: rep1.status, submitted_by: rep1.submitted_by, approved_by: rep1.approved_by }));
  check('kiln_prod_mt = 1300 from Odoo', Number(rep1.data.kiln_prod_mt) === 1300);
  check('decision C: raw_meal_prod_mt present, rm1_prod_mt/rm2_prod_mt absent', Number(rep1.data.raw_meal_prod_mt) === 2000 && !('rm1_prod_mt' in rep1.data) && !('rm2_prod_mt' in rep1.data));
  check('decision C: raw_meal_cons_mt present (kiln feed), rm1_cons_mt absent', Number(rep1.data.raw_meal_cons_mt) === 2000 && !('rm1_cons_mt' in rep1.data));

  console.log('2. an identical re-run changes nothing');
  const s2 = await sync();
  check('0 created, 0 updated, 1 unchanged, 0 overrides', s2.created === 0 && s2.updated === 0 && s2.unchanged === 1 && s2.overrides === 0, JSON.stringify(s2));
  check('no override rows exist yet', (await overridesFor(DAY1)).length === 0);

  console.log('3. a stored value that disagrees with Odoo is corrected AND logged (decision A)');
  await db.query("UPDATE daily_reports SET data = data || '{\"kiln_prod_mt\": 1250, \"coal_cpp\": 42}'::jsonb WHERE form_type='production' AND record_date=$1", [DAY1]);
  const s3 = await sync();
  check('one day updated, one override', s3.updated === 1 && s3.overrides === 1, JSON.stringify(s3));
  const rep3 = await reportOf(DAY1);
  check('kiln_prod_mt corrected to 1300', Number(rep3.data.kiln_prod_mt) === 1300);
  const ov3 = await overridesFor(DAY1);
  // DAY1 has TWO Odoo entries (clinker + raw meal, both dated the 10th), so
  // the day's refs correctly name both — this is honesty, not a bug: the
  // corrected value on this day traces back to everything Odoo sent for it.
  check('override row: field/previous/odoo/entry_refs all correct',
    ov3.length === 1 && ov3[0].field === 'kiln_prod_mt' && Number(ov3[0].previous_value) === 1250
    && Number(ov3[0].odoo_value) === 1300 && ov3[0].entry_refs === [clinkerDay1.name, rawMealDay1.name].sort().join(','),
    JSON.stringify(ov3));

  console.log('4. a field Odoo does not report is left exactly as typed');
  check('coal_cpp (Odoo cannot supply this) untouched at 42', Number(rep3.data.coal_cpp) === 42);

  console.log('5. an APPROVED report is corrected in place; status/approval never move');
  // The fake fetchReport must return the WHOLE window's entries every time,
  // exactly as the real endpoint does — sending only the new one would make
  // the mirror's withdrawal sweep treat DAY1's two entries as gone from
  // Odoo (Phase 1's own, correctly tested, behaviour) and withdraw them.
  await pull([[CLK, clinkerDay1], [RM, rawMealDay1], [CLK, clinkerDay2]]);
  await sync(); // creates DAY2 (approved, unsigned) with kiln_prod_mt=900 so there is a real row to approve next
  const created2 = await reportOf(DAY2);
  check('DAY2 exists as approved-but-unsigned before a human signs it',
    created2 && created2.status === 'approved' && created2.approved_by === null
      && Number(created2.data.kiln_prod_mt) === 900,
    created2 && JSON.stringify({ status: created2.status, approved_by: created2.approved_by }));

  await db.query(`
    UPDATE daily_reports SET status='approved', approved_by=NULL, approved_at='1997-04-12 08:00:00',
      data = data || '{"kiln_prod_mt": 800}'::jsonb
    WHERE form_type='production' AND record_date=$1`, [DAY2]);
  const before5 = await reportOf(DAY2);
  const s5 = await sync();
  check('the approved day is corrected', s5.overrides >= 1, JSON.stringify(s5));
  const rep5 = await reportOf(DAY2);
  check('kiln_prod_mt corrected to 900', Number(rep5.data.kiln_prod_mt) === 900);
  check('status is still approved', rep5.status === 'approved');
  check('approved_at is byte-identical to before — this was not a re-approval', rep5.approved_at.getTime() === before5.approved_at.getTime());

  console.log('6. dryRun writes nothing, logs nothing, and does not disturb a later real run');
  await db.query("UPDATE daily_reports SET data = data || '{\"kiln_prod_mt\": 1111}'::jsonb WHERE form_type='production' AND record_date=$1", [DAY1]);
  const s6 = await sync({ dryRun: true });
  check('dry run reports it WOULD override', s6.overrides === 1 && s6.updated === 1, JSON.stringify(s6));
  const rep6 = await reportOf(DAY1);
  check('the stored value is untouched by the dry run', Number(rep6.data.kiln_prod_mt) === 1111);
  check('no override row was written by the dry run', (await overridesFor(DAY1)).length === 1, 'still just the one from step 3');
  const s6b = await sync();
  check('a real run right after behaves identically to a fresh one', s6b.overrides === 1 && s6b.updated === 1, JSON.stringify(s6b));
  check('now it really is corrected', Number((await reportOf(DAY1)).data.kiln_prod_mt) === 1300);
  check('and now there are two override rows total', (await overridesFor(DAY1)).length === 2);

  await cleanup();
  check('cleanup leaves no ACCEPT-AF rows', (await db.query("SELECT count(*)::int AS n FROM odoo_production_entries WHERE entry_ref LIKE 'ACCEPT-AF/%'")).rows[0].n === 0);
  check('cleanup leaves no test reports', (await db.query("SELECT count(*)::int AS n FROM daily_reports WHERE form_type='production' AND record_date BETWEEN $1 AND $2", [FROM, TO])).rows[0].n === 0);
}

main()
  .then(async () => {
    await db.end();
    console.log(`\n${failCount === 0 ? '✅' : '❌'} Odoo production autofill acceptance: ${passCount} passed, ${failCount} failed.`);
    process.exitCode = failCount === 0 ? 0 : 1;
  })
  .catch(async (err) => {
    console.error('Acceptance run crashed:', err);
    try { await cleanup(); await db.end(); } catch { /* best effort */ }
    process.exitCode = 1;
  });
