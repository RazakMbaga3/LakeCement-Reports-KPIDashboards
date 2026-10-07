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
