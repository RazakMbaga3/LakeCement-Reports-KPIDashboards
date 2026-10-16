/*
  scripts/accept-odoo-production.js — acceptance tests for the Odoo production
  mirror (services/odooProductionSync.js, migration 018).

  The unit suite (test/odoo-production.test.js) proves the mapping in memory.
  This proves the part that needs a real Postgres: the upsert, amendment
  tracking, withdrawal of vanished entries, and the two guards that stop a bad
  Odoo response from wiping real days. No network — the Odoo fetch is faked —
  and no server: this integration has no route yet.

    1. first pull stores every entry; a second identical pull changes nothing
    2. facts read back from Postgres equal the mapper's, to the decimal
    3. an amended entry is rewritten, its revision counted, its day re-derived
    4. an entry that vanishes from Odoo is withdrawn (kept), leaves the day,
       and comes back if Odoo sends it again
    5. an EMPTY response never withdraws anything
    6. a response that would withdraw more than a quarter of a window is refused
    7. a malformed entry is rejected and does not get its stored copy withdrawn
    8. an unknown picking type is stored (stage NULL), reported, and feeds
       no fact
    9. a long range is fetched in consecutive windows; a failed fetch changes
       nothing

  Uses only refs starting 'ACCEPT/' on 1997 dates, and cleans up after itself.
  Needs migration 018 applied (npm run migrate). Exits 0 only if all pass.
  Usage: node scripts/accept-odoo-production.js
*/
require('../config/env');
const db = require('../db');
const { pullProductionEntries, loadRangeFacts, loadDayFacts } = require('../services/odooProductionSync');

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── fixture ─────────────────────────────────────────────────────────────
const CM1 = 'CEMENT: Cement Production (CM1)';
const CM2 = 'CEMENT: Cement Production (CM2)';
const RM  = 'CEMENT: Raw Meal Production';
const CLK = 'CEMENT: Clinker Production';
const FC  = 'CEMENT: Fine Coal Production';
/* The group key, which is how Odoo has identified crusher since 2026-10-08.
   Its line_items are weighbridge tickets, not consumption, so the fixture
   gives it a header quantity only — see normalizeEntry. */
const CRU = 'Crusher';
const item = (product, qty, dry = qty, uom = 'MT') => ({ product, uom, input_quantity: qty, stock_available: 50, moisture: 0, final_qty_after_moisture: dry, cost: 1 });
let seq = 0;
const raw = (day, product, produced, items = [], name = 'ACCEPT/' + String(++seq).padStart(3, '0')) => ({
  name, production_date: `${String(day).padStart(2, '0')}/03/1997`, product, uom: 'MT',
  total_input_qty: produced, produced_qty: produced, consumed_items: items,
});
const build = (parts) => {
  const out = {};
  for (const [picking, e] of parts) (out[picking] ||= []).push(e);
  return out;
};

const DAY = '1997-03-10';
const clinkerEntry = raw(10, '[WIP003] CLINKER', 1300, [item('[WIP002] RAW MEAL', 2000), item('[WIP004] FINE COAL', 200), item('[SER004] Power Units CPP', 90000, 90000, 'NOS')]);
const cm1Extra = raw(11, '[FG001] CEMENT 42.5 R', 100, [item('[WIP003] CLINKER', 80)]);
const BASE = [
  [RM,  raw(10, '[WIP002] RAW MEAL', 2000, [item('[WIP001] LIMESTONE MINING', 1000, 900), item('[QRM007] OB/CLAY', 50, 45)])],
  [CLK, clinkerEntry],
  [FC,  raw(10, '[WIP004] FINE COAL', 210, [item('[RM000001] COAL', 233.33, 210)])],
  [CM1, raw(10, '[FG001] CEMENT 42.5 R', 175, [item('[WIP003] CLINKER', 100), item('[RM000003] GYPSUM', 5, 4.75)])],
  [CM1, raw(10, '[FG001] CEMENT 42.5 R', 360, [item('[WIP003] CLINKER', 200), item('[RM000003] GYPSUM', 8, 7.6)])],
  [CM1, raw(10, '[FG002] CEMENT 32.5', 60, [item('[WIP003] CLINKER', 50)])],
  [CM2, raw(10, '[FG001] CEMENT 42.5 R', 294, [item('[WIP003] CLINKER', 250)])],
  [CM2, raw(10, '[FG005] CEMENT B-M 42.5 N', 100, [item('[WIP003] CLINKER', 60), item('[RM000014] CLINKER SPG', 5)])],
  [CM1, cm1Extra],
  /* Crusher joined ALL_STAGES on 2026-10-08. Without an entry here, the
     'every stage present' check below counted 5 of 6 and failed — the
     fixture, not the mapping, was stale. */
  [CRU, raw(10, '[WIP001] LIMESTONE MINING', 2806.2)],
];
const FROM = '1997-03-01', TO = '1997-03-31';
const N = BASE.length;

const pull = (parts, from = FROM, to = TO) => pullProductionEntries(from, to, { fetchReport: async () => build(parts) });
const cleanup = () => db.query("DELETE FROM odoo_production_entries WHERE entry_ref LIKE 'ACCEPT/%'");
const rowOf = async (ref) => (await db.query('SELECT *, produced_qty::float8 AS q FROM odoo_production_entries WHERE entry_ref = $1', [ref])).rows[0];
const liveCount = async () => (await db.query("SELECT count(*)::int AS n FROM odoo_production_entries WHERE entry_ref LIKE 'ACCEPT/%' AND withdrawn_at IS NULL")).rows[0].n;

async function main() {
  await cleanup();
  const t = await db.query("SELECT to_regclass('public.odoo_production_entries') AS t");
  if (!t.rows[0].t) { console.error('odoo_production_entries is missing — run: npm run migrate'); process.exit(1); }

  console.log('1. first pull stores everything; a repeat changes nothing');
  const r1 = await pull(BASE);
  check(`first pull adds all ${N}`, r1.added === N && r1.updated === 0 && r1.unchanged === 0 && r1.rejected === 0, JSON.stringify(r1));
  const r2 = await pull(BASE);
  check('identical second pull: 0 added, 0 updated, all unchanged', r2.added === 0 && r2.updated === 0 && r2.unchanged === N && r2.withdrawn === 0, JSON.stringify(r2));
  check('revision stays 1 on an unchanged entry', (await rowOf(clinkerEntry.name)).revision === 1);

  console.log('2. facts read back from Postgres');
  const day = await loadDayFacts(DAY);
  check('kiln_prod_mt = 1300', day && day.facts.kiln_prod_mt === 1300, JSON.stringify(day && day.facts));
  check('two CM1 42.5R entries sum to 535', day.facts.cm1_425r_mt === 535);
  check('CM2 Duramax (B-M) = 100 and CM1 OPC = 0', day.facts.cm2_425n_bm_mt === 100 && day.facts.cm1_opc_mt === 0);
  check('gypsum uses the wet quantity (13, not 12.35)', day.facts.cm_gypsum_cons === 13);
  check('purchased clinker = 5; own clinker = 660', day.facts.cm_clinker_purch_cons === 5 && day.facts.cm_clinker_own_cons === 660);
  check('power units are ignored, not reported as unmapped', day.unmapped.length === 0);
  check('all six stages present that day', day.stagesPresent.length === 6 && day.missingStages.length === 0, JSON.stringify({ present: day.stagesPresent, missing: day.missingStages }));
  check('crusher output lands in ls_crusher_prod_mt', day.facts.ls_crusher_prod_mt === 2806.2, JSON.stringify(day.facts.ls_crusher_prod_mt));
  const range = await loadRangeFacts(FROM, TO);
  check('the range read has exactly the two days that have entries', Object.keys(range).sort().join() === '1997-03-10,1997-03-11');
  check('a day with only a cement entry emits no kiln fact', !('kiln_prod_mt' in range['1997-03-11'].facts) && range['1997-03-11'].missingStages.includes('clinker'));

  console.log('3. an amended entry');
  const amended = BASE.map((p, i) => (i === 1 ? [CLK, { ...clinkerEntry, produced_qty: 1310 }] : p));
  const r3 = await pull(amended);
  check('exactly 1 updated, the rest unchanged', r3.updated === 1 && r3.unchanged === N - 1 && r3.added === 0, JSON.stringify(r3));
  const cr = await rowOf(clinkerEntry.name);
  check('revision 2, updated_at set', cr.revision === 2 && cr.updated_at !== null);
  check('the day is re-derived from the amended entry (1310)', (await loadDayFacts(DAY)).facts.kiln_prod_mt === 1310);

  console.log('4. an entry that vanishes from Odoo');
  const without = amended.filter(p => p[1] !== cm1Extra);
  const r4 = await pull(without);
  check('1 withdrawn, none deleted', r4.withdrawn === 1 && (await db.query("SELECT count(*)::int AS n FROM odoo_production_entries WHERE entry_ref LIKE 'ACCEPT/%'")).rows[0].n === N);
  check('the withdrawn row is marked and kept', (await rowOf(cm1Extra.name)).withdrawn_at !== null);
  check('its day no longer exists in the facts', (await loadDayFacts('1997-03-11')) === null);
  const r4b = await pull(amended);
  check('sent again, it is reinstated', r4b.reinstated === 1 && (await rowOf(cm1Extra.name)).withdrawn_at === null && (await loadDayFacts('1997-03-11')) !== null, JSON.stringify(r4b));

  console.log('5. an empty response never withdraws');
  const before = await liveCount();
  const r5 = await pull([]);
  check('sweep refused and reported', r5.withdrawn === 0 && r5.sweepsSkipped.length === 1 && /returned no entries/.test(r5.sweepsSkipped[0]), JSON.stringify(r5));
  check('every entry is still live', (await liveCount()) === before);

  console.log('6. an implausibly large withdrawal is refused');
  const extras = Array.from({ length: 30 }, (_, i) => [CM2, raw(20, '[FG001] CEMENT 42.5 R', 10 + i)]);
  await pull([...amended, ...extras]);
  const liveBefore = await liveCount();
  const r6 = await pull([...amended, ...extras.slice(0, 10)]);          // 20 of 39 would go; the limit is 9
  check('sweep refused: nothing withdrawn', r6.withdrawn === 0 && r6.sweepsSkipped.length === 1 && /would withdraw 20/.test(r6.sweepsSkipped[0]), JSON.stringify(r6));
  check('every entry is still live', (await liveCount()) === liveBefore);
  const r6b = await pull([...amended, ...extras.slice(0, 27)]);         // 3 go; under the floor of 5
  check('a small withdrawal (3) still self-heals', r6b.withdrawn === 3 && r6b.sweepsSkipped.length === 0, JSON.stringify(r6b));

  console.log('7. a malformed entry is rejected, and its stored copy is not swept');
  const bad = amended.map(p => [...p]);
  bad[3] = [CM1, { ...BASE[3][1], production_date: '31/02/1997' }];
  const r7 = await pull([...bad, ...extras.slice(0, 27)]);
  check('1 rejected with a reason', r7.rejected === 1 && /production_date/.test(r7.rejectSample[0].reason), JSON.stringify(r7));
  check('the stored copy was not withdrawn', r7.withdrawn === 0 && (await rowOf(BASE[3][1].name)).withdrawn_at === null);

  console.log('8. an unknown picking type');
  /* 'CEMENT: Crusher Production' was the example here until 2026-10-14, when
     it became a MAPPED stage — normalizeEntry prefers an entry's own
     picking_type, so leaving the long form unmapped meant crusher tonnage
     would vanish the day Odoo started stamping it. A name no rule covers is
     used instead, so this still exercises the unmapped path. */
  const unknown = raw(10, '[WIP001] LIMESTONE MINING', 500);
  const r8 = await pull([...amended, ...extras.slice(0, 27), ['CEMENT: Packing Production', unknown]]);
  check('reported by picking type', r8.unmappedPickingTypes['CEMENT: Packing Production'] === 1, JSON.stringify(r8.unmappedPickingTypes));
  const cru = await rowOf(unknown.name);
  check('stored with stage NULL', cru && cru.stage === null && cru.q === 500);
  const d8 = await loadDayFacts(DAY);
  check('it feeds no fact and is listed as unmapped', d8.facts.kiln_prod_mt === 1310 && d8.unmapped.some(u => u.kind === 'stage' && u.ref === unknown.name));

  console.log('9. windows and failures');
  const calls = [];
  const r9 = await pullProductionEntries('1997-06-01', '1997-08-20', { fetchReport: async (f, t2) => { calls.push([f, t2]); return {}; } });
  check('81 days = 3 consecutive windows, no gap', r9.windows === 3 && calls.length === 3 && calls[0][0] === '1997-06-01' && calls[2][1] === '1997-08-20'
    && Date.parse(calls[1][0]) - Date.parse(calls[0][1]) === 86400000, JSON.stringify(calls));
  const liveNow = await liveCount();
  let threw = null;
  try { await pullProductionEntries(FROM, TO, { fetchReport: async () => { throw new Error('Odoo is down'); } }); } catch (e) { threw = e; }
  check('a failed fetch throws and changes nothing', threw && /Odoo is down/.test(threw.message) && (await liveCount()) === liveNow);

  await cleanup();
  check('cleanup leaves no ACCEPT rows', (await db.query("SELECT count(*)::int AS n FROM odoo_production_entries WHERE entry_ref LIKE 'ACCEPT/%'")).rows[0].n === 0);
}

/* No process.exit(): pino's exit hook flushes its log worker synchronously and
   once threw "_flushSync took too long (10s)" here, turning 32 passes into a
   failing exit code. Closing the pool and letting the loop drain avoids it. */
main()
  .then(async () => {
    await db.end();
    console.log(`\n${failCount === 0 ? '✅' : '❌'} Odoo production acceptance: ${passCount} passed, ${failCount} failed.`);
    process.exitCode = failCount === 0 ? 0 : 1;
  })
  .catch(async (err) => {
    console.error('Acceptance run crashed:', err);
    try { await cleanup(); await db.end(); } catch { /* best effort */ }
    process.exitCode = 1;
  });
