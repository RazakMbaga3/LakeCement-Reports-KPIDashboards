/*
  scripts/accept-power-to-production.js — acceptance tests for
  services/powerToProduction.js against real Postgres.

  test/power-to-production.test.js proves the mapping and the decision rules
  in memory. This proves the part that needs the real daily_reports table,
  report_revisions and production_power_copy:

    1. blank and form-default 0 spc fields are FILLED from a reported
       power-cons day; spc_rm2_kwh / spc_losses_kwh are never touched
    2. a human-entered spc figure that differs is KEPT and logged as a conflict
    3. other fields of the production row (another writer's) are untouched,
       and status / approved_by / submitted_by never move
    4. one POWER_AUTOFILL revision, actor 'power-sync', with the pre-image
    5. a correction on the power report flows through to a value the copy
       wrote; a value a person changed afterwards does not
    6. a REJECTED (or draft) power report is not a source: the copy takes
       back only what it wrote — never writes 0 — and leaves people's values
    7. no production row -> nothing is created
    8. a re-run with nothing new writes nothing (idempotent)
    9. dryRun leaves no trace

  The power figures are the real 30.08.2026 Power Consumption report, as the
  form's own Excel import reads it (forms/excel-import.js 'power-cons').

  Uses only 1997-10-xx dates (no other acceptance script uses that month) and
  cleans up after itself. Needs migration 045 applied.
  Usage: node scripts/accept-power-to-production.js
*/
require('../config/env');
const { isDeepStrictEqual } = require('util');
const db = require('../db');
const { syncDay } = require('../services/powerToProduction');

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

const DAY = '1997-10-14';
const NO_PROD_DAY = '1997-10-15';
const FROM = '1997-10-01', TO = '1997-10-31';

/* 30.08.2026 daily Power Consumption report, as imported by the form. */
const POWER = {
  pwr_crusher_kwh: '1690.93', pwr_rawmill_kwh: '36344.11', pwr_rawmill2_kwh: '5710.10',
  pwr_coalmill_kwh: '12646.68', pwr_kiln_kwh: '56804.26', pwr_cm1_kwh: '64396.23',
  pwr_cm2_kwh: '31505.93', pwr_packing_kwh: '7190.17', pwr_lighting_kwh: '3542.53',
  pwr_colony_kwh: '1951.95',
};
/* What daily-report.html stores when an officer saves without touching the
   power row (every spc input pre-filled value="0"), plus one figure a person
   typed (kiln) and one field another writer owns (kiln_prod_mt). */
const PRODUCTION = {
  kiln_prod_mt: 2010,
  spc_crusher_kwh: '0', spc_rm1_kwh: '0', spc_rm2_kwh: '0', spc_kiln_kwh: '57096',
  spc_coalmill_kwh: '0', spc_cemmill_kwh: '0', spc_losses_kwh: '0', spc_pplant_kwh: '0',
  spc_others_kwh: '',
};

async function cleanup() {
  await db.query('DELETE FROM production_power_copy WHERE record_date BETWEEN $1 AND $2', [FROM, TO]);
  await db.query('DELETE FROM report_revisions WHERE record_date BETWEEN $1 AND $2', [FROM, TO]);
  await db.query('DELETE FROM daily_reports WHERE record_date BETWEEN $1 AND $2', [FROM, TO]);
}
async function row(formType, date = DAY) {
  const r = await db.query(
    'SELECT data, status, approved_by, submitted_by, updated_by FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3',
    [formType, date, 'day']);
  return r.rows[0] || null;
}
async function copyState() {
  const r = await db.query('SELECT field, state, copied_value, production_value, power_value FROM production_power_copy WHERE record_date = $1 ORDER BY field', [DAY]);
  return Object.fromEntries(r.rows.map(x => [x.field, x]));
}
async function powerRevisions() {
  const r = await db.query(
    "SELECT action, actor_id, actor_name, changed_fields, prior_data FROM report_revisions WHERE form_type = 'production' AND record_date = $1 AND action = 'POWER_AUTOFILL' ORDER BY revision",
    [DAY]);
  return r.rows;
}
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

async function main() {
  await cleanup();
  const userRes = await db.query('SELECT id FROM users ORDER BY id LIMIT 1');
  const someUser = userRes.rows[0] ? userRes.rows[0].id : null;

  await db.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, status, submitted_by, approved_by, approved_at)
     VALUES ('production', $1, 'day', $2::jsonb, 'approved', $3, $3, NOW())`,
    [DAY, JSON.stringify(PRODUCTION), someUser]);
  await db.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
     VALUES ('power-cons', $1, 'day', $2::jsonb, 'approved')`,
    [DAY, JSON.stringify(POWER)]);

  console.log('\n9. dryRun leaves no trace');
  const dry = await syncDay(DAY, { dryRun: true });
  check('dry run reports it would write', dry.action === 'would_write', dry.action);
  // deep equality, not JSON.stringify: jsonb stores keys in its own order
  check('dry run: production row unchanged', isDeepStrictEqual((await row('production')).data, PRODUCTION));
  check('dry run: no revision', (await powerRevisions()).length === 0);
  check('dry run: no copy-state rows', Object.keys(await copyState()).length === 0);

  console.log('\n1–4. first run');
  const r1 = await syncDay(DAY);
  const p1 = await row('production');
  check('action = wrote', r1.action === 'wrote', r1.action);
  check('crusher filled over the form-default 0', num(p1.data.spc_crusher_kwh) === 1690.93, p1.data.spc_crusher_kwh);
  check('RAW MILL-1 = RM-1 + RM-2 (42,054.21)', num(p1.data.spc_rm1_kwh) === 42054.21, p1.data.spc_rm1_kwh);
  check('coal mill filled', num(p1.data.spc_coalmill_kwh) === 12646.68);
  check('CEM MILL = CM-1 + CM-2 (95,902.16)', num(p1.data.spc_cemmill_kwh) === 95902.16, p1.data.spc_cemmill_kwh);
  check('P.PLANT filled from Packing (7,190.17)', num(p1.data.spc_pplant_kwh) === 7190.17);
  check('OTHERS = utilities + colony, filled over a blank (5,494.48)', num(p1.data.spc_others_kwh) === 5494.48, p1.data.spc_others_kwh);
  check('kiln: the typed 57,096 is KEPT', p1.data.spc_kiln_kwh === '57096', p1.data.spc_kiln_kwh);
  check('spc_rm2_kwh untouched (still the form default)', p1.data.spc_rm2_kwh === '0');
  check('spc_losses_kwh untouched', p1.data.spc_losses_kwh === '0');
  check("another writer's field untouched", p1.data.kiln_prod_mt === 2010);
  check('status / approved_by / submitted_by unchanged',
    p1.status === 'approved' && p1.approved_by === someUser && p1.submitted_by === someUser);
  const cs1 = await copyState();
  check('kiln logged as a conflict with both figures',
    cs1.spc_kiln_kwh && cs1.spc_kiln_kwh.state === 'conflict'
      && num(cs1.spc_kiln_kwh.production_value) === 57096 && num(cs1.spc_kiln_kwh.power_value) === 56804.26);
  check('six fields recorded as copied',
    Object.values(cs1).filter(x => x.state === 'copied').length === 6);
  const rev1 = await powerRevisions();
  check('one POWER_AUTOFILL revision, no human actor',
    rev1.length === 1 && rev1[0].actor_id === null && rev1[0].actor_name === 'power-sync');
  check('revision lists exactly the six written fields',
    rev1[0] && rev1[0].changed_fields.join(',') === 'spc_cemmill_kwh,spc_coalmill_kwh,spc_crusher_kwh,spc_others_kwh,spc_pplant_kwh,spc_rm1_kwh',
    rev1[0] && rev1[0].changed_fields.join(','));
  check('revision keeps the pre-image', rev1[0] && rev1[0].prior_data.spc_crusher_kwh === '0');

  console.log('\n8. idempotent re-run');
  const r2 = await syncDay(DAY);
  check('re-run writes nothing', r2.action === 'conflicts_only', r2.action);
  check('re-run adds no revision', (await powerRevisions()).length === 1);

  console.log('\n5. corrections');
  await db.query(
    `UPDATE daily_reports SET data = data || '{"pwr_crusher_kwh":"1700.5","pwr_coalmill_kwh":"12000"}'::jsonb
      WHERE form_type = 'power-cons' AND record_date = $1`, [DAY]);
  // a person retypes coal mill on the Production report before the copy re-runs
  await db.query(
    `UPDATE daily_reports SET data = data || '{"spc_coalmill_kwh":"13000"}'::jsonb
      WHERE form_type = 'production' AND record_date = $1`, [DAY]);
  const r3 = await syncDay(DAY);
  const p3 = await row('production');
  check('power correction flows to a copied value', num(p3.data.spc_crusher_kwh) === 1700.5, p3.data.spc_crusher_kwh);
  check('outcome says updated', r3.outcome.spc_crusher_kwh === 'updated', r3.outcome.spc_crusher_kwh);
  check('a value a person changed after the copy is kept', p3.data.spc_coalmill_kwh === '13000');
  const cs3 = await copyState();
  check('...and is now a conflict, no longer owned',
    cs3.spc_coalmill_kwh && cs3.spc_coalmill_kwh.state === 'conflict' && cs3.spc_coalmill_kwh.copied_value === null);

  console.log('\n6. a rejected power report is not a source');
  await db.query("UPDATE daily_reports SET status = 'rejected' WHERE form_type = 'power-cons' AND record_date = $1", [DAY]);
  const r4 = await syncDay(DAY);
  const p4 = await row('production');
  check('copied fields are removed, not zeroed',
    ['spc_crusher_kwh', 'spc_rm1_kwh', 'spc_cemmill_kwh', 'spc_pplant_kwh', 'spc_others_kwh'].every(f => !(f in p4.data)),
    JSON.stringify(r4.remove));
  check("people's figures stay (kiln, coal mill)", p4.data.spc_kiln_kwh === '57096' && p4.data.spc_coalmill_kwh === '13000');
  check('the form-default zeros the copy never owned stay', p4.data.spc_rm2_kwh === '0' && p4.data.spc_losses_kwh === '0');
  check('no copy-state rows remain', Object.keys(await copyState()).length === 0);

  console.log('   …and a draft is treated the same way');
  await db.query("UPDATE daily_reports SET status = 'draft' WHERE form_type = 'power-cons' AND record_date = $1", [DAY]);
  const r5 = await syncDay(DAY);
  check('draft power report writes nothing', r5.action === 'unchanged', r5.action);
  await db.query("UPDATE daily_reports SET status = 'pending_approval' WHERE form_type = 'power-cons' AND record_date = $1", [DAY]);
  const r6 = await syncDay(DAY);
  check('pending_approval is reported -> fills again', r6.action === 'wrote' && num((await row('production')).data.spc_rm1_kwh) === 42054.21, r6.action);

  console.log('\n7. no production row');
  await db.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, status) VALUES ('power-cons', $1, 'day', $2::jsonb, 'approved')`,
    [NO_PROD_DAY, JSON.stringify(POWER)]);
  const r7 = await syncDay(NO_PROD_DAY);
  check('reports no_production_row', r7.action === 'no_production_row', r7.action);
  check('creates no production row', (await row('production', NO_PROD_DAY)) === null);

  await cleanup();
  console.log(`\n${passCount} passed, ${failCount} failed`);
  await db.end();
  process.exit(failCount ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.end().catch(() => {});
  process.exit(1);
});
