/*
  test/odoo-production-autofill.test.js — the pure half of Phase 3
  (services/odooProductionAutofill.js): which fields Odoo is allowed to
  write, and what counts as "changed" against a day that already has data.
  No database — that part is scripts/accept-odoo-production-autofill.js.

  Usage: node --test test/odoo-production-autofill.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');

const mapper   = require('../services/odooProductionMapper');
const { odooFieldsFor, reconcileDay } = require('../services/odooProductionAutofill');

const item = (product, input) => ({ product, uom: 'MT', input_quantity: input, stock_available: 1, moisture: 0, final_qty_after_moisture: input, cost: 1 });
/* No picking_type: the group key names the stage. It used to carry a junk
   string with the note "ignored — the group key wins", which stopped being
   true on 2026-10-08 — normalizeEntry now prefers the entry's own
   picking_type, because Odoo's shortened group key ('Cement') cannot tell
   CM1 from CM2. See test/odoo-production.test.js. */
const entry = (name, product, produced, items = [], date = '15/06/2026') => ({
  name, production_date: date, product, uom: 'MT',
  total_input_qty: produced, produced_qty: produced, consumed_items: items,
});
const toMapperEntries = (rows) => rows.map(r => ({
  ref: r.entry_ref, stage: r.stage, product_code: r.product_code,
  produced_qty: r.produced_qty, consumed_items: r.consumed_items,
}));
const dayFrom = (report) => mapper.mapDay(toMapperEntries(mapper.flattenReport(report).rows));

const CLINKER_DAY = {
  'CEMENT: Clinker Production': [entry('CLK/1', '[WIP003] CLINKER', 1300, [item('[WIP002] RAW MEAL', 2000), item('[WIP004] FINE COAL', 200)])],
};
const RAW_MEAL_DAY = {
  'CEMENT: Raw Meal Production': [entry('RML/1', '[WIP002] RAW MEAL', 2000, [item('[WIP001] LIMESTONE MINING', 1000)])],
};

// ── odooFieldsFor: decision C's renaming ─────────────────────────────────
test('odooFieldsFor: facts pass through untouched', () => {
  const d = dayFrom(CLINKER_DAY);
  const fields = odooFieldsFor(d);
  assert.equal(fields.kiln_prod_mt, 1300);
  assert.equal(fields.coalmill_cons_mt, 200);
});

test('odooFieldsFor: raw meal produced (extras) is renamed to raw_meal_prod_mt, not forced into rm1/rm2', () => {
  const fields = odooFieldsFor(dayFrom(RAW_MEAL_DAY));
  assert.equal(fields.raw_meal_prod_mt, 2000);
  assert.equal('rm1_prod_mt' in fields, false, 'must never write the mill-specific field itself');
  assert.equal('rm2_prod_mt' in fields, false);
});

test('odooFieldsFor: kiln raw-meal feed (provisional rm1_cons_mt) is renamed to raw_meal_cons_mt', () => {
  const fields = odooFieldsFor(dayFrom(CLINKER_DAY));
  assert.equal(fields.raw_meal_cons_mt, 2000);
  assert.equal('rm1_cons_mt' in fields, false, 'must never write the mill-specific field itself');
});

test('odooFieldsFor: a stage with no entry contributes neither raw-meal key', () => {
  const fields = odooFieldsFor(dayFrom({}));
  assert.deepEqual(fields, {});
});

// ── reconcileDay: decisions A and B ──────────────────────────────────────
test('reconcileDay: no existing report -> every Odoo field is a fresh write, no overrides', () => {
  const { toWrite, overrides } = reconcileDay(null, { kiln_prod_mt: 1300, coalmill_cons_mt: 200 });
  assert.deepEqual(toWrite, { kiln_prod_mt: 1300, coalmill_cons_mt: 200 });
  assert.deepEqual(overrides, []);
});

test('reconcileDay: an existing report with the field blank is filled, not counted as an override', () => {
  const { toWrite, overrides } = reconcileDay({ kiln_prod_mt: '' }, { kiln_prod_mt: 1300 });
  assert.deepEqual(toWrite, { kiln_prod_mt: 1300 });
  assert.deepEqual(overrides, [], 'a blank is not a disagreement — nothing to log');
});

test('reconcileDay: a stored value that already matches Odoo is left alone', () => {
  const { toWrite, overrides } = reconcileDay({ kiln_prod_mt: 1300 }, { kiln_prod_mt: 1300 });
  assert.deepEqual(toWrite, {});
  assert.deepEqual(overrides, []);
});

test('reconcileDay: rounding noise is not a disagreement', () => {
  const { toWrite, overrides } = reconcileDay({ kiln_prod_mt: 1300.001 }, { kiln_prod_mt: 1300 });
  assert.deepEqual(toWrite, {});
  assert.deepEqual(overrides, []);
});

test('reconcileDay: decision A — a stored value that disagrees with Odoo is overwritten and logged', () => {
  const { toWrite, overrides } = reconcileDay({ kiln_prod_mt: 1250 }, { kiln_prod_mt: 1300 });
  assert.deepEqual(toWrite, { kiln_prod_mt: 1300 });
  assert.deepEqual(overrides, [{ field: 'kiln_prod_mt', previous_value: 1250, odoo_value: 1300 }]);
});

test('reconcileDay: a field Odoo does not send is never touched, whatever the officer typed', () => {
  const { toWrite, overrides } = reconcileDay(
    { kiln_prod_mt: 1250, coal_cpp: 999, kiln_run_hours: 22.5 },
    { kiln_prod_mt: 1300 }); // Odoo only reports the one field this day
  assert.deepEqual(toWrite, { kiln_prod_mt: 1300 });
  assert.equal('coal_cpp' in toWrite, false);
  assert.equal('kiln_run_hours' in toWrite, false);
  assert.deepEqual(overrides, [{ field: 'kiln_prod_mt', previous_value: 1250, odoo_value: 1300 }]);
});

test('reconcileDay: several fields, mixed outcomes, in one call', () => {
  const existing = { kiln_prod_mt: 1300, coalmill_prod_mt: 205, coalmill_cons_mt: '' };
  const odoo      = { kiln_prod_mt: 1300, coalmill_prod_mt: 210, coalmill_cons_mt: 200 };
  const { toWrite, overrides } = reconcileDay(existing, odoo);
  assert.deepEqual(toWrite, { coalmill_prod_mt: 210, coalmill_cons_mt: 200 }, 'kiln_prod_mt matched, so it is absent — not merely 0');
  assert.deepEqual(overrides, [{ field: 'coalmill_prod_mt', previous_value: 205, odoo_value: 210 }]);
});

test('reconcileDay: a non-numeric stored value (garbled data) is treated as blank, not as a mismatch to log', () => {
  const { toWrite, overrides } = reconcileDay({ kiln_prod_mt: 'N/A' }, { kiln_prod_mt: 1300 });
  assert.deepEqual(toWrite, { kiln_prod_mt: 1300 });
  assert.deepEqual(overrides, [], 'nothing numeric existed to disagree with — this is a fill, not a correction');
});
