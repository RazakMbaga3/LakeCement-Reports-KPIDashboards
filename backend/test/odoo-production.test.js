/*
  test/odoo-production.test.js — the pure half of the Odoo production_report
  integration: date/entry parsing, change hashing, the day-facts mapping, and
  the client's request/failure handling. No database and no network.

  The mapping numbers below are hand-computed from the fixture, not copied
  from the code under test. The rules themselves were checked against 91 real
  days (1 Apr - 30 Jun 2026) on 2026-09-20; this file keeps them from drifting.

  Usage: node --test test/odoo-production.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const MAP    = require('../config/odooProductionMap');
const mapper = require('../services/odooProductionMapper');
const { fetchProductionReport, isConfigured } = require('../services/odooProductionClient');

// ── fixture helpers ─────────────────────────────────────────────────────
const item = (product, input, dry = input, uom = 'MT') => ({
  product, uom, input_quantity: input, stock_available: 100, moisture: 0, final_qty_after_moisture: dry, cost: 1,
});
/* `picking_type` is left undefined so the GROUP KEY names the stage, which is
   how Crusher entries arrive (they carry no picking_type at all).

   It used to be set to a junk string with the note "ignored — the group key
   wins". That stopped being true on 2026-10-08: Odoo shortened the group keys
   to 'Cement', which cannot distinguish CM1 from CM2, so normalizeEntry now
   PREFERS the entry's own picking_type and falls back to the group key.
   entryWithPicking() below covers that preferred path. */
const entry = (name, product, produced, items = [], date = '15/06/2026') => ({
  name, production_date: date, product, uom: 'MT',
  total_input_qty: produced, produced_qty: produced, consumed_items: items,
});

/* An entry carrying its own picking_type, as every non-Crusher entry does.
   `groupKey` is what the response nests it under — deliberately a short,
   ambiguous label here, to prove the entry's own field is what decides. */
const entryWithPicking = (pickingType, name, product, produced, items = [], date = '15/06/2026') => ({
  ...entry(name, product, produced, items, date), picking_type: pickingType,
});
const toMapperEntries = (rows) => rows.map(r => ({
  ref: r.entry_ref, stage: r.stage, product_code: r.product_code,
  produced_qty: r.produced_qty, consumed_items: r.consumed_items,
}));
const dayFrom = (report) => mapper.mapDay(toMapperEntries(mapper.flattenReport(report).rows));

const LIME = '[WIP001] LIMESTONE MINING';
const CLINKER = '[WIP003] CLINKER';
const GYPSUM = '[RM000003] GYPSUM';
const SPG = '[RM000014] CLINKER SPG';
const CM1 = 'CEMENT: Cement Production (CM1)';
const CM2 = 'CEMENT: Cement Production (CM2)';

// One full day. Dry quantities are deliberately different from wet ones, so a
// rule that reads the wrong column cannot pass by accident.
const FULL_DAY = {
  'CEMENT: Raw Meal Production': [
    entry('RML/1', '[WIP002] RAW MEAL', 2000, [
      item(LIME, 1000, 900), item('[QRM007] OB/CLAY', 50, 45), item('[QRM008] ID Clay', 0),
      item('[RM000004] IRON ORE', 20, 18), item('[RM000007] BAUXITE', 0),
    ]),
  ],
  'CEMENT: Clinker Production': [
    entry('CLK/1', CLINKER, 1300, [
      item('[WIP002] RAW MEAL', 2000), item('[WIP004] FINE COAL', 200), item('[RM000002] COAL ASH', 0),
      item('[SER004] Power Units CPP', 100000, 100000, 'NOS'), item('[SER005] Power Units TANESCO', 0, 0, 'NOS'),
    ]),
  ],
  'CEMENT: Fine Coal Production': [
    entry('CLM/1', '[WIP004] FINE COAL', 210, [item('[RM000001] COAL', 233.33, 210)]),
  ],
  [CM1]: [
    entry('CEM/1', '[FG001] CEMENT 42.5 R', 175, [
      item(CLINKER, 100), item(LIME, 20, 18), item(LIME, 0), item(GYPSUM, 5, 4.75), item(SPG, 10),
      item('[SER005] Power Units TANESCO', 12000, 12000, 'NOS'),
    ]),
    entry('CEM/2', '[FG001] CEMENT 42.5 R', 360, [item(CLINKER, 200), item(LIME, 40, 36), item(GYPSUM, 8, 7.6), item(SPG, 0)]),
    entry('CEM/3', '[FG002] CEMENT 32.5', 60, [item(CLINKER, 50), item(LIME, 0), item(GYPSUM, 2, 1.9), item(SPG, 0)]),
  ],
  [CM2]: [
    entry('CEM/4', '[FG001] CEMENT 42.5 R', 294, [item(CLINKER, 250), item(LIME, 30, 27), item(GYPSUM, 15, 14.25), item(SPG, 0)]),
    entry('CEM/5', '[FG005] CEMENT B-M 42.5 N', 100, [item(CLINKER, 60), item(LIME, 10, 9), item(GYPSUM, 4, 3.8), item(SPG, 5)]),
  ],
};

// ── parsing ─────────────────────────────────────────────────────────────
test('parseEntryDate reads Odoo DD/MM/YYYY and ISO, and refuses everything else', () => {
  assert.equal(mapper.parseEntryDate('15/06/2026'), '2026-06-15');
  assert.equal(mapper.parseEntryDate('01/01/2024'), '2024-01-01');
  assert.equal(mapper.parseEntryDate('2026-06-15'), '2026-06-15');
  assert.equal(mapper.parseEntryDate('29/02/2028'), '2028-02-29');       // leap day
  for (const bad of ['31/02/2026', '2026-02-30', '15-06-2026', '6/5/2026', '2026-6-1', '', null, undefined, 'x']) {
    assert.equal(mapper.parseEntryDate(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('codeOf / nameOf split "[CODE] NAME"; a bare name is its own code', () => {
  assert.equal(mapper.codeOf('[WIP003] CLINKER'), 'WIP003');
  assert.equal(mapper.nameOf('[WIP003] CLINKER'), 'CLINKER');
  assert.equal(mapper.codeOf('LS2'), 'LS2');
  assert.equal(mapper.nameOf('LS2'), 'LS2');
  assert.equal(mapper.codeOf(''), '');
});

test('normalizeEntry stores a real-shaped entry and derives stage, code and hash', () => {
  const { row, reject } = mapper.normalizeEntry(CM1, entry('CEM/2026/02168', '[FG001] CEMENT 42.5 R', 560, [item(CLINKER, 443.408)]));
  assert.equal(reject, undefined);
  assert.equal(row.entry_ref, 'CEM/2026/02168');
  assert.equal(row.production_date, '2026-06-15');
  assert.equal(row.stage, 'cm1');
  assert.equal(row.product_code, 'FG001');
  assert.equal(row.product_name, 'CEMENT 42.5 R');
  assert.equal(row.produced_qty, 560);
  assert.equal(row.consumed_items[0].code, 'WIP003');
  assert.match(row.content_hash, /^[0-9a-f]{16}$/);
});

test('normalizeEntry refuses an entry it cannot trust, and says why', () => {
  const good = () => entry('X/1', '[FG001] CEMENT 42.5 R', 10, [item(CLINKER, 5)]);
  const cases = [
    [{ ...good(), name: '' },                              /no name/],
    [{ ...good(), production_date: '31/02/2026' },         /production_date/],
    [{ ...good(), produced_qty: 'abc' },                   /produced_qty/],
    [{ ...good(), produced_qty: -1 },                      /produced_qty/],
    [{ ...good(), consumed_items: 'nope' },                /consumed_items/],
    [{ ...good(), consumed_items: [{ product: '[WIP003] CLINKER', input_quantity: 'x' }] }, /input_quantity/],
    [null,                                                 /not an object/],
  ];
  for (const [raw, why] of cases) {
    const { row, reject } = mapper.normalizeEntry(CM1, raw);
    assert.equal(row, undefined);
    assert.match(reject, why);
  }
});

test('an unknown picking type is stored with stage null, not dropped', () => {
  /* Was 'CEMENT: Crusher Production' until 2026-10-14. That is now a MAPPED
     stage (config/odooProductionMap.js), so it no longer demonstrates the
     unknown-type path — a real unmapped name is used instead. */
  const { row } = mapper.normalizeEntry('CEMENT: Packing Production', entry('PKG/1', '[WIP001] LIMESTONE MINING', 500));
  assert.equal(row.stage, null);
});

test('crusher maps from the long form as well as the group key', () => {
  /* normalizeEntry prefers an entry's own picking_type over the group key, so
     the day Odoo starts stamping crusher entries the long way, the group-key
     fallback stops being consulted. Both spellings must land on 'crusher' or
     the tonnage silently disappears. */
  for (const pt of ['Crusher', 'CEMENT: Crusher Production']) {
    const { row } = mapper.normalizeEntry(pt, entry('CRU/1', '[WIP001] LIMESTONE MINING', 2806.2));
    assert.equal(row.stage, 'crusher', pt);
    assert.equal(row.produced_qty, 2806.2, pt);
    assert.deepEqual(row.consumed_items, [], 'crusher ticket lines are not consumption');
  }
});

test('contentHash is stable, and changes when any quantity in the entry changes', () => {
  const base = mapper.normalizeEntry(CM1, entry('A/1', '[FG001] CEMENT 42.5 R', 100, [item(CLINKER, 50, 50)])).row;
  const same = mapper.normalizeEntry(CM1, entry('A/1', '[FG001] CEMENT 42.5 R', 100, [item(CLINKER, 50, 50)])).row;
  assert.equal(base.content_hash, same.content_hash);

  const editedProduced = mapper.normalizeEntry(CM1, entry('A/1', '[FG001] CEMENT 42.5 R', 101, [item(CLINKER, 50, 50)])).row;
  const editedConsumed = mapper.normalizeEntry(CM1, entry('A/1', '[FG001] CEMENT 42.5 R', 100, [item(CLINKER, 51, 50)])).row;
  const editedDate     = mapper.normalizeEntry(CM1, entry('A/1', '[FG001] CEMENT 42.5 R', 100, [item(CLINKER, 50, 50)], '16/06/2026')).row;
  for (const other of [editedProduced, editedConsumed, editedDate]) assert.notEqual(other.content_hash, base.content_hash);
});

test('flattenReport keeps good rows, reports rejects, and counts a repeated reference', () => {
  const report = {
    [CM1]: [entry('A/1', '[FG001] CEMENT 42.5 R', 10), entry('A/1', '[FG001] CEMENT 42.5 R', 12), entry('', '[FG001] CEMENT 42.5 R', 5)],
    'CEMENT: Clinker Production': [entry('CLK/1', CLINKER, 100)],
    'CEMENT: Broken': 'not a list',
  };
  const { rows, rejects, duplicateRefs } = mapper.flattenReport(report);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.entry_ref === 'A/1').produced_qty, 12, 'the later copy wins');
  assert.equal(duplicateRefs, 1);
  assert.equal(rejects.length, 2);
  assert.deepEqual(mapper.flattenReport({}).rows, []);
  assert.deepEqual(mapper.flattenReport(null).rows, []);
});

test('splitRange cuts a range into consecutive windows with no gap or overlap', () => {
  assert.deepEqual(mapper.splitRange('2026-09-01', '2026-09-20'), [{ from: '2026-09-01', to: '2026-09-20' }]);
  const w = mapper.splitRange('2026-01-01', '2026-03-31', 31);
  assert.deepEqual(w[0], { from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(w[1], { from: '2026-02-01', to: '2026-03-03' });
  assert.equal(w[w.length - 1].to, '2026-03-31');
  for (let i = 1; i < w.length; i++) {
    assert.equal(Date.parse(w[i].from) - Date.parse(w[i - 1].to), 86400000, 'consecutive');
  }
  assert.deepEqual(mapper.splitRange('2026-09-05', '2026-09-05'), [{ from: '2026-09-05', to: '2026-09-05' }]);
});

// ── the day mapping ─────────────────────────────────────────────────────
test('mapDay: a full day maps every rule, on the wet basis, summed across entries', () => {
  const d = dayFrom(FULL_DAY);
  assert.deepEqual(d.facts, {
    // raw-mill feed (wet input, not the dry final)
    rmm_limestone_cons: 1000, rmm_clay_cons: 50, rmm_industrialclay_cons: 0, rmm_ironore_cons: 20, rmm_bauxite_cons: 0,
    // clinker and coal
    kiln_prod_mt: 1300, coalmill_cons_mt: 200, coalmill_prod_mt: 210, coal_kiln: 233.33,
    // cement by mill and grade; two CM1 42.5R entries add up; grades with no entry are 0
    cm1_425r_mt: 535, cm1_325n_mt: 60, cm1_425n_mt: 0, cm1_opc_mt: 0, cm1_425n_bm_mt: 0,
    cm2_425r_mt: 294, cm2_425n_bm_mt: 100, cm2_325n_mt: 0, cm2_425n_mt: 0, cm2_opc_mt: 0,
    // cement-mill consumption, CM1 + CM2 together
    cm_clinker_own_cons: 660, cm_clinker_purch_cons: 15, cm_gypsum_cons: 34, cm_limestone_cons: 100,
    // derived: raw-mill limestone + cement-mill limestone
    ls_crusher_cons_mt: 1100,
  });
  assert.deepEqual(d.provisional, { rm1_cons_mt: 2000 });
  assert.deepEqual(d.extras, { raw_meal_prod_mt: 2000 });
  assert.deepEqual(d.stagesPresent, ['raw_meal', 'clinker', 'fine_coal', 'cm1', 'cm2']);
  // 'crusher' joined ALL_STAGES on 2026-10-08; this fixture has no crusher entry.
  assert.deepEqual(d.missingStages, ['crusher']);
  assert.deepEqual(d.unmapped, [], 'power units and a 0-qty coal ash line are known and ignored');
  assert.equal(d.entryCount, 8);
  assert.deepEqual(d.refs, ['CEM/1', 'CEM/2', 'CEM/3', 'CEM/4', 'CEM/5', 'CLK/1', 'CLM/1', 'RML/1']);
});

test('mapDay: a stage with no entry contributes no facts — nothing is defaulted to 0', () => {
  const onlyCm1 = dayFrom({ [CM1]: FULL_DAY[CM1] });
  assert.deepEqual(onlyCm1.stagesPresent, ['cm1']);
  assert.deepEqual(onlyCm1.missingStages, ['raw_meal', 'clinker', 'fine_coal', 'cm2', 'crusher']);
  for (const k of ['kiln_prod_mt', 'coalmill_prod_mt', 'rmm_limestone_cons', 'coal_kiln', 'cm2_425r_mt', 'coalmill_cons_mt']) {
    assert.equal(k in onlyCm1.facts, false, `${k} must be absent when its stage has no entry`);
  }
  assert.equal(onlyCm1.facts.cm1_425r_mt, 535);
  assert.equal(onlyCm1.facts.cm1_opc_mt, 0, 'a present mill that made none of a grade made 0 of it');
  assert.equal(onlyCm1.facts.ls_crusher_cons_mt, onlyCm1.facts.cm_limestone_cons, 'raw mill absent, so only the cement draw');
  assert.deepEqual(onlyCm1.provisional, {});

  const onlyRaw = dayFrom({ 'CEMENT: Raw Meal Production': FULL_DAY['CEMENT: Raw Meal Production'] });
  assert.equal('cm_gypsum_cons' in onlyRaw.facts, false);
  assert.equal(onlyRaw.facts.ls_crusher_cons_mt, 1000);
});

test('mapDay: anything no rule covers stays visible instead of vanishing', () => {
  const d = dayFrom({
    'CEMENT: Packing Production': [entry('PKG/1', '[WIP001] LIMESTONE MINING', 500)],
    [CM1]: [entry('CEM/9', '[FG099] CEMENT NEW GRADE', 40, [item(CLINKER, 30)])],
    'CEMENT: Raw Meal Production': [entry('RML/9', '[WIP002] RAW MEAL', 100, [item(LIME, 60), item('[RM000099] NEW ADDITIVE', 5), item('[RM000098] ZERO ITEM', 0)])],
  });
  const kinds = d.unmapped.map(u => `${u.kind}:${u.ref}`).sort();
  assert.deepEqual(kinds, ['consumed:RML/9', 'product:CEM/9', 'stage:PKG/1']);
  assert.equal(d.facts.cm1_425r_mt, 0, 'an unknown grade must not be filed under a known one');
  assert.equal(d.facts.cm_clinker_own_cons, 30, 'the clinker it used is still counted');
});

// ── the map itself ──────────────────────────────────────────────────────
test('the map is internally consistent', () => {
  const facts = MAP.CONSUMPTION_RULES.map(r => r.fact);
  assert.equal(new Set(facts).size, facts.length, 'each consumption fact comes from exactly one rule');
  const produced = Object.values(MAP.PRODUCED_BY_STAGE);
  for (const d of MAP.DERIVED_FACTS) {
    assert.equal(facts.includes(d.fact) || produced.includes(d.fact), false, `${d.fact} is derived, so no rule may also set it`);
    for (const src of d.sumOf) assert.ok(facts.includes(src), `${d.fact} sums ${src}, which must be a real rule`);
  }
  for (const stage of Object.values(MAP.STAGE_BY_PICKING_TYPE)) assert.ok(MAP.ALL_STAGES.includes(stage));
  assert.equal(new Set(Object.values(MAP.GRADE_BY_PRODUCT)).size, Object.keys(MAP.GRADE_BY_PRODUCT).length, 'one suffix per grade');
});

test('every fact the mapper can emit is a real data-field in daily-report.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'daily-report.html'), 'utf8');
  const formFields = new Set([...html.matchAll(/data-field="([^"]+)"/g)].map(m => m[1]));
  const missing = mapper.emittableFactKeys().filter(k => !formFields.has(k));
  assert.deepEqual(missing, [], 'these would be prefilled into a field the form does not have');
});

// ── the client ──────────────────────────────────────────────────────────
function withClient(fn) {
  return async () => {
    const saved = { fetch: global.fetch, url: process.env.ODOO_PRODUCTION_URL, key: process.env.ODOO_PRODUCTION_API_KEY };
    process.env.ODOO_PRODUCTION_URL = 'https://erp.example.test/production_report';
    process.env.ODOO_PRODUCTION_API_KEY = 'test-key';
    try { await fn(); } finally {
      global.fetch = saved.fetch;
      for (const [k, v] of [['ODOO_PRODUCTION_URL', saved.url], ['ODOO_PRODUCTION_API_KEY', saved.key]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  };
}
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('client: refuses to run unconfigured, with no fallback to other Odoo settings', async () => {
  const saved = { url: process.env.ODOO_PRODUCTION_URL, key: process.env.ODOO_PRODUCTION_API_KEY, dash: process.env.ODOO_DASHBOARD_URL };
  delete process.env.ODOO_PRODUCTION_URL; delete process.env.ODOO_PRODUCTION_API_KEY;
  process.env.ODOO_DASHBOARD_URL = 'https://erp.example.test';
  try {
    assert.equal(isConfigured(), false);
    await assert.rejects(fetchProductionReport('2026-09-01', '2026-09-02'), /not configured/);
  } finally {
    for (const [k, v] of [['ODOO_PRODUCTION_URL', saved.url], ['ODOO_PRODUCTION_API_KEY', saved.key], ['ODOO_DASHBOARD_URL', saved.dash]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('client: sends a form-encoded POST with ISO dates — never a JSON body', withClient(async () => {
  let seen;
  global.fetch = async (url, opts) => { seen = { url, opts }; return reply(200, { status: true, message: 'All Data Loaded', code: 200, data: { [CM1]: [] } }); };
  const data = await fetchProductionReport('2026-09-01', '2026-09-20');
  assert.equal(seen.url, 'https://erp.example.test/production_report');
  assert.equal(seen.opts.method, 'POST');
  assert.ok(seen.opts.body instanceof URLSearchParams, 'form-encoded body');
  assert.equal(seen.opts.body.get('api_key'), 'test-key');
  assert.equal(seen.opts.body.get('from_date'), '2026-09-01');
  assert.equal(seen.opts.body.get('to_date'), '2026-09-20');
  assert.equal(seen.opts.headers, undefined, 'no JSON content-type');
  assert.deepEqual(data, { [CM1]: [] });
}));

test('client: an empty window is {} whether Odoo sends {} , [] or null', withClient(async () => {
  for (const empty of [{}, [], null]) {
    global.fetch = async () => reply(200, { status: true, message: 'All Data Loaded', code: 200, data: empty });
    assert.deepEqual(await fetchProductionReport('2001-01-01', '2001-01-02'), {});
  }
}));

test('client: failures are named so an operator can act on them', withClient(async () => {
  global.fetch = async () => reply(401, { status: false, message: 'Authentication failed, Please Check Your API Key.' });
  await assert.rejects(fetchProductionReport('2026-09-01', '2026-09-02'), /rejected the production report API key.*ODOO_PRODUCTION_API_KEY/s);

  global.fetch = async () => reply(500, 'boom');
  await assert.rejects(fetchProductionReport('2026-09-01', '2026-09-02'), /HTTP 500/);

  global.fetch = async () => reply(200, { status: false, message: 'Some Odoo problem' });
  await assert.rejects(fetchProductionReport('2026-09-01', '2026-09-02'), /Some Odoo problem/);

  global.fetch = async () => reply(200, '{"status": true, "data": {"CEMENT: Clin');           // cut off mid-record
  await assert.rejects(fetchProductionReport('2026-09-01', '2026-09-02'), /incomplete/);

  global.fetch = async () => ({ status: 200, ok: true, text: async () => { throw new TypeError('terminated'); } });
  await assert.rejects(fetchProductionReport('2026-09-01', '2026-09-02'), /cut off/);

  global.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(fetchProductionReport('2026-09-01', '2026-09-02'), /unreachable/);

  global.fetch = async () => reply(200, { status: true, data: 'a string' });
  await assert.rejects(fetchProductionReport('2026-09-01', '2026-09-02'), /unexpected shape/);
}));

/* ── the 2026-10-08 Odoo payload change ──────────────────────────────────
   Odoo renamed most of the response in one deploy and shortened the group
   keys. Every entry was rejected for a day before it was noticed, because
   health reported the pull itself as "ok". These lock the new shape in. */

test('the renamed 2026-10-08 payload parses, and the old names still do', () => {
  const nu = mapper.normalizeEntry('Clinker', {
    name: 'CLK/2026/00182', production_date: '07/10/2026',
    picking_type: 'CEMENT: Clinker Production',
    product_id: '[WIP003] CLINKER', uom_id: 'MT',
    production_qty: 1810, total_input_qty: 3065.5,
    coal_ncv: 5598, running_hours: 23.833333333333332, tph: 75.944,
    line_items: [{ product_id: '[WIP002] RAW MEAL', uom_id: 'MT', quantity: 2805.5,
      qty_available: 4723.56, moisture_percent: 0, final_qty: 2805.5, standard_price: 5891.77 }],
  });
  assert.equal(nu.reject, undefined);
  assert.equal(nu.row.stage, 'clinker');
  assert.equal(nu.row.produced_qty, 1810, 'production_qty is read as produced_qty');
  assert.equal(nu.row.coal_ncv, 5598);
  assert.equal(nu.row.consumed_items[0].input_quantity, 2805.5, 'line quantity is read');

  // The pre-2026-10-08 names must keep working, so a rollback cannot break us.
  const old = mapper.normalizeEntry('CEMENT: Clinker Production',
    entry('CLK/1', '[WIP003] CLINKER', 1000, [item(CLINKER, 500)]));
  assert.equal(old.reject, undefined);
  assert.equal(old.row.produced_qty, 1000);
  assert.equal(old.row.consumed_items[0].input_quantity, 500);
});

test("the entry's own picking_type beats the group key, so CM1 and CM2 stay apart", () => {
  // Both nested under the short 'Cement' key Odoo now uses, which cannot
  // name a mill. Merging them would halve each mill's reported tonnage.
  const day = dayFrom({
    Cement: [
      entryWithPicking(CM1, 'CEM/1', '[FG001] CEMENT 42.5 R', 100, [item(CLINKER, 80)]),
      entryWithPicking(CM2, 'CEM/2', '[FG001] CEMENT 42.5 R', 250, [item(CLINKER, 200)]),
    ],
  });
  assert.deepEqual(day.stagesPresent, ['cm1', 'cm2']);
  assert.equal(day.facts.cm1_425r_mt, 100);
  assert.equal(day.facts.cm2_425r_mt, 250);
});

test('NCV is a weighted mean, never a sum, and an absent reading is not zero', () => {
  const twoRuns = mapper.mapDay([
    { ref: 'CLK/1', stage: 'clinker', produced_qty: 1000, consumed_items: [], coal_ncv: 5000, running_hours: 12 },
    { ref: 'CLK/2', stage: 'clinker', produced_qty: 3000, consumed_items: [], coal_ncv: 6000, running_hours: 10 },
  ]);
  // (5000*1000 + 6000*3000) / 4000 = 5750 — not 11000, and not the plain mean 5500.
  assert.equal(twoRuns.facts.coal_ncv, 5750);
  assert.equal(twoRuns.facts.kiln_run_hrs, 22, 'hours are a quantity, so they sum');

  const noNcv = mapper.mapDay([
    { ref: 'CLK/3', stage: 'clinker', produced_qty: 1000, consumed_items: [], coal_ncv: null },
  ]);
  assert.equal('coal_ncv' in noNcv.facts, false,
    'no NCV reported must stay absent — a fabricated 0 would feed a divisor');
});

test('a Crusher entry keeps its header output and drops its weighbridge lines', () => {
  // Crusher line_items are tickets (product_uom_qty, ticket_no), not
  // consumption: running them through the item mapper rejected the entry.
  const { row, reject } = mapper.normalizeEntry('Crusher', {
    name: 'CRU/2026/00191', production_date: '07/10/2026',
    product: '[WIP001] LIMESTONE MINING', uom: 'MT',
    production_qty: 2806.2, running_hours: 18.866666666666667,
    line_items: [
      { product_id: '[WIP001] LIMESTONE MINING', uom_id: 'MT', product_uom_qty: 20, ticket_no: 'MN06102605' },
      { product_id: '[WIP001] LIMESTONE MINING', uom_id: 'MT', product_uom_qty: 22, ticket_no: 'MN06102606' },
    ],
  });
  assert.equal(reject, undefined, 'a ticket line must not reject the whole entry');
  assert.equal(row.stage, 'crusher');
  assert.equal(row.produced_qty, 2806.2);
  assert.deepEqual(row.consumed_items, [], 'tickets are not consumption — the quarry pipeline owns those');

  const day = mapper.mapDay([{ ref: row.entry_ref, stage: 'crusher', produced_qty: 2806.2,
    consumed_items: [], running_hours: 18.866666666666667 }]);
  assert.equal(day.facts.ls_crusher_prod_mt, 2806.2);
  assert.equal(day.facts.ls_crusher_run_hrs, 18.87);
});

/* ── apron-feeder hours (2026-10-15, migration 040) ──────────────────────
   Crusher TPH = production ÷ APRON FEEDER running hours (Razak, 2026-10-15).
   The fixture is CRU/2026/00180 exactly as production_report returned it
   for 2026-09-26 (header only; its 191 ticket lines are irrelevant here),
   which is also the entry the user photographed on the Odoo screen:
   3,969.84 t over 17.45 apron hours = 227.5 t/h. */
const CRU_0926 = {
  name: 'CRU/2026/00180', production_date: '26/09/2026', state: 'Approved', approval_status: 'Approved',
  running_hours: 21.4, apron_feeder_hrs: 17.45, count: 191, production_qty: 3969.8399999999992,
  picking_type: '', product: '', uom: '', line_items: [],
};
const crusherDay = (...es) => mapper.mapDay(es.map((e, i) => ({
  ref: `CRU/T/${i}`, stage: 'crusher', consumed_items: [], ...e,
})));

test('a Crusher entry carries its apron-feeder hours; other stages carry null, never 0', () => {
  const { row, reject } = mapper.normalizeEntry('Crusher', CRU_0926);
  assert.equal(reject, undefined);
  assert.equal(row.stage, 'crusher');
  assert.equal(row.apron_feeder_hrs, 17.45);
  assert.equal(row.running_hours, 21.4, 'running hours are kept exactly as they were');
  assert.equal(row.produced_qty, 3969.8399999999992);

  const clk = mapper.normalizeEntry('Clinker', entryWithPicking('CEMENT: Clinker Production', 'CLK/1', CLINKER, 1000)).row;
  assert.equal(clk.apron_feeder_hrs, null);
  // Odoo's JSON uses false for an empty field; that is "no reading", not 0.
  assert.equal(mapper.normalizeEntry('Crusher', { ...CRU_0926, apron_feeder_hrs: false }).row.apron_feeder_hrs, null);
});

test('apron hours are hashed on crusher rows only, so no other stage records a fake revision', () => {
  /* Both hashes pinned from the mapper as committed before this change
     (HEAD 1c89c64). The clinker one must not move: if it did, the next pull
     would bump `revision` on every non-crusher row in the mirror (~9,100 on
     the dev DB) as though Odoo had edited them all. */
  const clk = mapper.normalizeEntry('Clinker', {
    name: 'CLK/2026/00182', production_date: '07/10/2026', picking_type: 'CEMENT: Clinker Production',
    product_id: '[WIP003] CLINKER', uom_id: 'MT', production_qty: 1810, total_input_qty: 3065.5,
    coal_ncv: 5598, running_hours: 23.833333333333332, tph: 75.944,
    line_items: [{ product_id: '[WIP002] RAW MEAL', uom_id: 'MT', quantity: 2805.5, qty_available: 4723.56,
      moisture_percent: 0, final_qty: 2805.5, standard_price: 5891.77 }],
  }).row;
  assert.equal(clk.content_hash, '00fc4c2c02739ed1', 'a non-crusher hash is unchanged by the new field');

  const cru = mapper.normalizeEntry('Crusher', CRU_0926).row;
  assert.notEqual(cru.content_hash, '4044b622ee4ae5c5',
    'the crusher hash must move once, so the re-pull is counted as an update and the row is rewritten');

  const corrected = mapper.normalizeEntry('Crusher', { ...CRU_0926, apron_feeder_hrs: 17.5 }).row;
  assert.notEqual(corrected.content_hash, cru.content_hash, 'an apron-only correction in Odoo is a revision');
});

test('mapDay: apron hours become ls_crusher_apron_hrs, summed across a split day', () => {
  const one = crusherDay({ produced_qty: 3969.8399999999992, running_hours: 21.4, apron_feeder_hrs: 17.45 });
  assert.equal(one.facts.ls_crusher_apron_hrs, 17.45);
  assert.equal(one.facts.ls_crusher_run_hrs, 21.4);
  assert.equal(one.facts.ls_crusher_prod_mt, 3969.84);

  // 2026-09-30 arrived as two entries, CRU/2026/00184 + 00185 (Odoo values).
  const split = crusherDay(
    { produced_qty: 2027.6400000000006, running_hours: 13.883333333333333, apron_feeder_hrs: 11.666666666666666 },
    { produced_qty: 1862.1399999999987, running_hours: 8.883333333333333, apron_feeder_hrs: 5.333333333333333 });
  assert.equal(split.facts.ls_crusher_apron_hrs, 17);
  assert.equal(split.facts.ls_crusher_prod_mt, 3889.78);
  assert.equal(split.facts.ls_crusher_run_hrs, 22.77);
});

test('mapDay: a missing, zero or partial apron reading leaves the fact absent — never a fabricated divisor', () => {
  const none = crusherDay({ produced_qty: 2000, running_hours: 20, apron_feeder_hrs: null });
  assert.equal('ls_crusher_apron_hrs' in none.facts, false, 'no reading is not 0 hours');
  assert.equal(none.facts.ls_crusher_prod_mt, 2000, 'the rest of the entry still maps');
  assert.equal(none.facts.ls_crusher_run_hrs, 20);

  const zero = crusherDay({ produced_qty: 2000, running_hours: 20, apron_feeder_hrs: 0 });
  assert.equal('ls_crusher_apron_hrs' in zero.facts, false, '0 apron hours on an entry that crushed 2,000 t is not a reading');

  // One of two entries with tonnage lacks its hours: 3,000 t over 10 h would
  // read 300 t/h. The day gets no apron figure instead.
  const partial = crusherDay(
    { produced_qty: 2000, running_hours: 12, apron_feeder_hrs: 10 },
    { produced_qty: 1000, running_hours: 6, apron_feeder_hrs: null });
  assert.equal('ls_crusher_apron_hrs' in partial.facts, false);
  assert.equal(partial.facts.ls_crusher_prod_mt, 3000);

  // An entry with no tonnage cannot bias the ratio, so it does not void the day.
  const idleSplit = crusherDay(
    { produced_qty: 2000, running_hours: 12, apron_feeder_hrs: 10 },
    { produced_qty: 0, running_hours: 0.5, apron_feeder_hrs: null });
  assert.equal(idleSplit.facts.ls_crusher_apron_hrs, 10);
});

test('apron backfill: fills blanks only, and only pairs apron hours with Odoo\'s own tonnage', () => {
  /* scripts/odoo-crusher-apron-backfill.js — the one-off that put apron hours
     on existing reports. Real days from the dev DB, 2026-10-15. */
  const { planDay } = require('../scripts/odoo-crusher-apron-backfill');
  const odoo = { ls_crusher_prod_mt: 3969.84, ls_crusher_run_hrs: 21.4, ls_crusher_apron_hrs: 17.45 };

  // 2026-09-26: an Odoo-created report with no crusher figures yet -> all three filled.
  assert.deepEqual(planDay({ kiln_prod_mt: 1800 }, odoo),
    { write: { ls_crusher_prod_mt: 3969.84, ls_crusher_run_hrs: 21.4, ls_crusher_apron_hrs: 17.45 }, withheld: null });

  // Report tonnage already equals Odoo's -> only the apron hours are new.
  assert.deepEqual(planDay({ ls_crusher_prod_mt: 3969.84, ls_crusher_run_hrs: 21.4 }, odoo).write,
    { ls_crusher_apron_hrs: 17.45 });

  // 2026-05-01: the Excel figure (9,628.22 t) is not the Crusher Production
  // Entry's (2,695.52 t). Nothing is overwritten, and apron hours are withheld
  // rather than divided into a tonnage they do not describe.
  const may1 = planDay({ ls_crusher_prod_mt: 9628.22, ls_crusher_run_hrs: 20 },
    { ls_crusher_prod_mt: 2695.52, ls_crusher_run_hrs: 16.3, ls_crusher_apron_hrs: 13.1 });
  assert.deepEqual(may1.write, {}, 'a stored human/Excel value is never overwritten');
  assert.deepEqual(may1.withheld, { reportTonnage: 9628.22, odooTonnage: 2695.52, apron: 13.1 });

  // A value someone already typed for apron hours is left alone.
  assert.deepEqual(planDay({ ls_crusher_prod_mt: 3969.84, ls_crusher_apron_hrs: 17 }, odoo).write, { ls_crusher_run_hrs: 21.4 });
  // Re-running after a fill finds nothing to do.
  assert.deepEqual(planDay({ ...odoo }, odoo), { write: {}, withheld: null });
});

test('ls_crusher_apron_hrs is an emitted fact under exactly that name (Daily MIS contract)', () => {
  // The Daily MIS Mining section reads this key by name. Renaming it here
  // would silently blank that section, so the name is pinned.
  assert.ok(mapper.emittableFactKeys().includes('ls_crusher_apron_hrs'));
  const rule = MAP.HEADER_FACTS.find(h => h.fact === 'ls_crusher_apron_hrs');
  assert.deepEqual([rule.stage, rule.field, rule.agg], ['crusher', 'apron_feeder_hrs', 'sum']);
});

test('a 0 calorific value is a placeholder, not a reading, and never dilutes a real one', () => {
  // Odoo sends coal_ncv: 0 on every Raw Meal / Cement / Coal Mill entry, and
  // on a clinker entry before the lab figure is keyed in. Taken literally it
  // makes Specific Thermal Energy Consumption read 0 kcal/kg.
  const placeholder = mapper.mapDay([
    { ref: 'CLK/A', stage: 'clinker', produced_qty: 1500, consumed_items: [], coal_ncv: 0, running_hours: 20 },
  ]);
  assert.equal('coal_ncv' in placeholder.facts, false, '0 NCV must not be stored as a reading');
  assert.equal(placeholder.facts.kiln_run_hrs, 20, 'the rest of the entry still maps');

  const mixed = mapper.mapDay([
    { ref: 'CLK/B', stage: 'clinker', produced_qty: 1000, consumed_items: [], coal_ncv: 0 },
    { ref: 'CLK/C', stage: 'clinker', produced_qty: 1000, consumed_items: [], coal_ncv: 5500 },
  ]);
  assert.equal(mixed.facts.coal_ncv, 5500, 'a placeholder must not halve a real reading to 2750');

  // A genuine zero for a QUANTITY is real information and must survive.
  const idle = mapper.mapDay([
    { ref: 'CLM/A', stage: 'fine_coal', produced_qty: 200, consumed_items: [], running_hours: 0 },
  ]);
  assert.equal(idle.facts.coalmill_run_hrs, 0, 'a mill that ran 0 hours really ran 0 hours');
});
