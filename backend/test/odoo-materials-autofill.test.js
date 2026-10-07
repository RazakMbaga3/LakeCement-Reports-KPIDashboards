/*
  test/odoo-materials-autofill.test.js — the pure half of the Raw Material
  autofill (services/odooMaterialsAutofill.js): which columns Odoo is
  allowed to write, and what happens when it disagrees with a figure an
  officer already typed. No database.

  The two properties under test are the ones that make this report safe to
  run unattended:

    1. Odoo writes RECEIPTS ONLY. It never writes consumption, opening,
       closing or min/max — because it does not know them. A zero in a
       consumption cell would overstate stock on hand by a full day's burn.
    2. Odoo never overwrites an officer's figure. On a disagreement the
       stored value is kept and the difference is reported.

  Usage: node --test test/odoo-materials-autofill.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ODOO_OWNED_SUFFIXES, odooFieldsFor, reconcileDay, carryForwardOpening,
} = require('../services/odooMaterialsAutofill');

/* Shaped exactly like storesReport.receiptsForDate()'s return value. */
const receipts = (rows, unassigned = []) => ({ rows, unassigned });
const row = (name, mt, pendingMt = 0) => ({
  row: name, material: 'coal', destination: 'kiln', label: name,
  mt, trucks: 1, pending_grn_mt: pendingMt, pending_grn_trucks: pendingMt ? 1 : 0,
});

// ── odooFieldsFor: receipts only, nothing else ───────────────────────────

test('odooFieldsFor: writes received and pending-GRN for each row', () => {
  const f = odooFieldsFor(receipts([row('ck_market', 347.96, 31.9)]));
  assert.equal(f.ck_market_rcvd, 347.96);
  assert.equal(f.ck_market_grn, 31.9);
});

test('odooFieldsFor: NEVER writes consumption, opening, closing or min/max', () => {
  const f = odooFieldsFor(receipts([
    row('ck_market', 347.96, 31.9),
    row('gypsum', 127.92),
    row('cc_stamico', 201.02),
  ]));
  /* The guardrail that matters most: Odoo has no consumption data at all
     (stores_issues is diesel/PPE/spares), so a consumption key here would
     be fabricated — and would silently inflate closing stock. */
  for (const key of Object.keys(f)) {
    const suffix = key.replace(/^.*?_(?=[a-z]+$)/, '');
    assert.ok(ODOO_OWNED_SUFFIXES.includes(suffix),
      `autofill wrote '${key}', but Odoo may only write ${ODOO_OWNED_SUFFIXES.join('/')}`);
  }
  for (const forbidden of ['ck_market_cons', 'ck_market_open', 'ck_market_close',
    'ck_market_min', 'ck_market_max', 'gypsum_cons', 'gypsum_open']) {
    assert.equal(forbidden in f, false, `must never write ${forbidden}`);
  }
});

test('odooFieldsFor: a row with no tonnage is omitted, not written as zero', () => {
  /* An absent key leaves the officer's cell alone; an explicit 0 would
     assert "nothing arrived" and overwrite a figure they typed. */
  const f = odooFieldsFor(receipts([row('ck_tancoal', 0, 0)]));
  assert.equal('ck_tancoal_rcvd' in f, false);
  assert.equal('ck_tancoal_grn' in f, false);
});

test('odooFieldsFor: pending GRN is omitted when everything is booked', () => {
  const f = odooFieldsFor(receipts([row('gypsum', 127.92, 0)]));
  assert.equal(f.gypsum_rcvd, 127.92);
  assert.equal('gypsum_grn' in f, false);
});

test('odooFieldsFor: unmatched trucks contribute no fields', () => {
  /* They are surfaced separately (summary.unassignedDays) — never folded
     into a mapped row to make a total look complete. */
  const f = odooFieldsFor(receipts([], [{ token: 'T1', mt: 119.9, reason: 'Material code not recognised' }]));
  assert.deepEqual(f, {});
});

// ── reconcileDay: the officer outranks Odoo ──────────────────────────────

test('reconcileDay: fills a day that has no report yet', () => {
  const { toWrite, conflicts } = reconcileDay(null, { ck_market_rcvd: 347.96 });
  assert.equal(toWrite.ck_market_rcvd, 347.96);
  assert.equal(conflicts.length, 0);
});

test('reconcileDay: a literal 0 counts as unfilled (the grid is seeded with zeros)', () => {
  const { toWrite } = reconcileDay({ ck_market_rcvd: 0 }, { ck_market_rcvd: 347.96 });
  assert.equal(toWrite.ck_market_rcvd, 347.96);
});

test('reconcileDay: an officer\'s differing figure is KEPT and reported as a conflict', () => {
  const { toWrite, conflicts } = reconcileDay(
    { ck_market_rcvd: 350 }, { ck_market_rcvd: 347.96 });
  assert.equal('ck_market_rcvd' in toWrite, false, 'must not overwrite a typed figure');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], { field: 'ck_market_rcvd', stored_value: 350, odoo_value: 347.96 });
});

test('reconcileDay: a matching figure writes nothing (a re-run is a no-op)', () => {
  const { toWrite, conflicts } = reconcileDay(
    { ck_market_rcvd: 347.96 }, { ck_market_rcvd: 347.96 });
  assert.deepEqual(toWrite, {});
  assert.equal(conflicts.length, 0);
});

test('reconcileDay: float noise below tolerance is not a conflict', () => {
  const { toWrite, conflicts } = reconcileDay(
    { ck_market_rcvd: 347.96 }, { ck_market_rcvd: 347.9602 });
  assert.deepEqual(toWrite, {});
  assert.equal(conflicts.length, 0);
});

test('reconcileDay: blank and missing stored values are both fillable', () => {
  const { toWrite } = reconcileDay(
    { ck_market_rcvd: '' }, { ck_market_rcvd: 347.96, gypsum_rcvd: 127.92 });
  assert.equal(toWrite.ck_market_rcvd, 347.96);
  assert.equal(toWrite.gypsum_rcvd, 127.92);
});

test('reconcileDay: one conflicting row does not block the others', () => {
  const { toWrite, conflicts } = reconcileDay(
    { ck_market_rcvd: 350 },
    { ck_market_rcvd: 347.96, gypsum_rcvd: 127.92, cc_stamico_rcvd: 201.02 });
  assert.equal(conflicts.length, 1);
  assert.equal(toWrite.gypsum_rcvd, 127.92);
  assert.equal(toWrite.cc_stamico_rcvd, 201.02);
});

// ── carryForwardOpening: yesterday's closing becomes today's opening ─────

test('carryForwardOpening: closing = opening + received − consumed is carried down', () => {
  const prev = { ck_market_open: 100, ck_market_rcvd: 50, ck_market_cons: 20 };
  const open = carryForwardOpening(prev, '2026-10-01', '2026-10-02');
  assert.equal(open.ck_market_open, 130);
});

test('carryForwardOpening: a CPP draw depletes its supplier\'s KILN pile', () => {
  /* ck_jitegemee is paired with cc_jitegemee: the CPP row holds no stock of
     its own, it draws off the kiln pile. Missing this would overstate coal
     by the whole CPP burn, every day. */
  const prev = {
    ck_jitegemee_open: 1000, ck_jitegemee_rcvd: 100, ck_jitegemee_cons: 50,
    cc_jitegemee_cons: 30,
  };
  const open = carryForwardOpening(prev, '2026-10-01', '2026-10-02');
  assert.equal(open.ck_jitegemee_open, 1020, '1000 + 100 − 50 − 30');
});

test('carryForwardOpening: a consOnly row gets no opening of its own', () => {
  const open = carryForwardOpening(
    { cc_jitegemee_cons: 30, ck_jitegemee_open: 10 }, '2026-10-01', '2026-10-02');
  assert.equal('cc_jitegemee_open' in open, false);
});

test('carryForwardOpening: carries ONLY from the immediately-preceding day', () => {
  /* Across a gap the intervening receipts and draws are unknown, so an
     older closing figure is not this day's opening — it is a stale number
     wearing today's date. */
  const prev = { ck_market_open: 100, ck_market_rcvd: 50 };
  assert.deepEqual(carryForwardOpening(prev, '2026-09-20', '2026-10-02'), {},
    'a 12-day gap must carry nothing');
  assert.deepEqual(carryForwardOpening(prev, '2026-10-02', '2026-10-02'), {},
    'the same day is not a previous day');
});

test('carryForwardOpening: carries across a month boundary', () => {
  const open = carryForwardOpening(
    { gypsum_open: 10, gypsum_rcvd: 5 }, '2026-09-30', '2026-10-01');
  assert.equal(open.gypsum_open, 15);
});

test('carryForwardOpening: no previous day carries nothing', () => {
  assert.deepEqual(carryForwardOpening(null, '2026-10-01', '2026-10-02'), {});
});

test('carryForwardOpening: writes opening only — never receipts or consumption', () => {
  const open = carryForwardOpening(
    { ck_market_open: 100, ck_market_rcvd: 50, ck_market_cons: 20 },
    '2026-10-01', '2026-10-02');
  for (const key of Object.keys(open)) {
    assert.ok(key.endsWith('_open'), `carry-forward wrote '${key}', which is not an opening`);
  }
});

// ── Consumption, from the production feed ────────────────────────────────

test('odooFieldsFor: writes consumption for the three mapped rows', () => {
  const f = odooFieldsFor(receipts([]), { gypsum: 94.8, iron_ore: 89, clinker: 1791.88 });
  assert.equal(f.gypsum_cons, 94.8);
  assert.equal(f.iron_ore_cons, 89);
  assert.equal(f.clinker_cons, 1791.88);
});

test('odooFieldsFor: a positively-reported zero consumption IS written', () => {
  /* Unlike a receipt. consumptionForDate() omits a material Odoo said
     nothing about, so anything reaching here is a real statement that the
     mills ran and took none. */
  const f = odooFieldsFor(receipts([]), { iron_ore: 0 });
  assert.equal(f.iron_ore_cons, 0);
});

test('odooFieldsFor: consumption and receipts coexist on the same row', () => {
  const f = odooFieldsFor(receipts([row('gypsum', 127.92, 31.9)]), { gypsum: 94.8 });
  assert.equal(f.gypsum_rcvd, 127.92);
  assert.equal(f.gypsum_grn, 31.9);
  assert.equal(f.gypsum_cons, 94.8);
});

test('odooFieldsFor: no consumption argument leaves every _cons cell alone', () => {
  const f = odooFieldsFor(receipts([row('gypsum', 127.92)]));
  assert.equal(Object.keys(f).some(k => k.endsWith('_cons')), false);
});

test('odooFieldsFor: coal consumption is never written, whatever is passed', () => {
  /* Coal has no supplier split in Odoo and no CPP burn in any feed, so a
     kiln total would understate the burn and overstate the pile. If a
     future change maps it, config/odooMaterialConsumption.js must be read
     first — this test is the tripwire. */
  const { CONSUMPTION_ROWS } = require('../config/odooMaterialConsumption');
  for (const r of CONSUMPTION_ROWS) {
    assert.ok(!r.startsWith('ck_') && !r.startsWith('cc_'),
      `'${r}' is a coal row; coal consumption cannot be filled from one Odoo total`);
  }
});

// ── carryForwardOpening: the negative guard ──────────────────────────────

test('carryForwardOpening: a negative closing is NOT carried', () => {
  /* Stock cannot go below zero. A negative here means the chain was
     started with no real opening balance, not that the yard is in deficit
     — carrying it compounds the error daily (clinker hit −10,409 MT). */
  const open = carryForwardOpening(
    { iron_ore_open: 0, iron_ore_rcvd: 30, iron_ore_cons: 109 },
    '2026-09-01', '2026-09-02');
  assert.equal('iron_ore_open' in open, false);
});

test('carryForwardOpening: a zero closing IS carried (a genuinely empty pile)', () => {
  const open = carryForwardOpening(
    { gypsum_open: 50, gypsum_rcvd: 0, gypsum_cons: 50 }, '2026-10-01', '2026-10-02');
  assert.equal(open.gypsum_open, 0);
});

test('carryForwardOpening: one negative row does not block the others', () => {
  const open = carryForwardOpening(
    { iron_ore_open: 0, iron_ore_cons: 109, gypsum_open: 100, gypsum_cons: 40 },
    '2026-10-01', '2026-10-02');
  assert.equal('iron_ore_open' in open, false);
  assert.equal(open.gypsum_open, 60);
});

// ── Own production joins the received column ─────────────────────────────

test('odooFieldsFor: clinker production is ADDED to gate receipts, not substituted', () => {
  /* The report's own tile reads "own production + purchased receipts". A
     plant that both burns its own and buys in must show the sum. */
  const f = odooFieldsFor(receipts([row('clinker', 5)]), {}, { clinker: 1703 });
  assert.equal(f.clinker_rcvd, 1708);
});

test('odooFieldsFor: production fills the received column when nothing was bought', () => {
  const f = odooFieldsFor(receipts([]), {}, { clinker: 1703 });
  assert.equal(f.clinker_rcvd, 1703);
});

test('odooFieldsFor: only clinker has a production source — gypsum/iron ore are bought', () => {
  const { PRODUCTION_SOURCES } = require('../config/odooMaterialConsumption');
  assert.deepEqual(Object.keys(PRODUCTION_SOURCES), ['clinker']);
});

test('odooFieldsFor: a clinker day with a draw but no kiln entry still writes the draw', () => {
  /* Today's kiln entry often posts after the mills'. The draw is real and
     is written; the resulting negative closing is caught by the opening
     guard rather than propagated to tomorrow. */
  const f = odooFieldsFor(receipts([]), { clinker: 1013.306 }, {});
  assert.equal(f.clinker_cons, 1013.306);
  assert.equal('clinker_rcvd' in f, false);
});
