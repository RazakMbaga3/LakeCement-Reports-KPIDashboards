/*
  test/formula-engine-shifts.test.js — the engine's day-vs-shift contract.

  formulas.test.js checks the registry's arithmetic with hand-built fact
  objects. This file checks the layer ABOVE it: how services/formulaEngine.js
  turns daily_reports ROWS into those fact objects, which is where a real
  divergence lived.

  The bug: buildEntries() keyed one entry per (date, shift). evalMonth() then
  aggregated every shift as its own entry while evalDaily() kept only one of
  them, so a monthlyAgg:'sum' KPI read 2x higher on a KPI card than on the
  trend chart beside it. services/misReport.js gatherMonthly() calls BOTH, so
  a single MIS pack disagreed with itself. Every row in the database is
  shift='day' today, so nothing historical was ever wrong — but the forms
  accept 'night' and 'all' (middleware/validate.js zShift), so it was one
  night-shift entry away from silently doubling a headline figure.

  The contract now: the unit of evaluation is the CALENDAR DAY. One entry per
  date, facts from every form and every shift merged into it, so evalMonth()
  and evalDaily() are two views of the same rows by construction.

  Needs Postgres (it writes and removes rows). Uses year 2001 as the sandbox,
  the same convention as the e2e harness, so it can never collide with real
  plant data. Skips itself cleanly when no database is reachable.

  Usage: node --test test/formula-engine-shifts.test.js   (from backend/)
*/

require('../config/env');
const test   = require('node:test');
const assert = require('node:assert/strict');

const db     = require('../db');
const engine = require('../services/formulaEngine');

const DATE  = '2001-05-10';
const FROM  = '2001-05-01';
const TO    = '2001-05-31';

/* A 'sum' KPI is the one that shows double-counting, and total-power-kwh
   reads a single form, so the fixture stays small and the expected
   arithmetic stays obvious. */
const KEY = 'total-power-kwh';

/* Minimal power-cons payload. Field names (not fact keys) are what the row
   holds, so they are read from the registry rather than hardcoded — if a
   field is ever renamed this fixture follows it instead of silently zeroing. */
const { FACTS, FORMULAS } = require('../../forms/formula-registry.js');

function payload(kwhPerSection) {
  const data = {};
  for (const factKey of FORMULAS[KEY].inputs) {
    const fact = FACTS[factKey];
    if (fact && fact.form === 'power-cons') data[fact.field] = kwhPerSection;
  }
  return data;
}

const SECTIONS = FORMULAS[KEY].inputs.filter(k => FACTS[k] && FACTS[k].form === 'power-cons').length;
const PER_SECTION = 1000;
const ONE_ROW_TOTAL = SECTIONS * PER_SECTION;

async function reachable() {
  try { await db.query('SELECT 1'); return true; } catch { return false; }
}

async function clean() {
  await db.query('DELETE FROM daily_reports WHERE record_date = $1', [DATE]);
}

async function insert(shift) {
  await db.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
     VALUES ('power-cons', $1, $2, $3, 'approved')`,
    [DATE, shift, JSON.stringify(payload(PER_SECTION))]
  );
}

async function readBoth() {
  const monthly = (await engine.evalMonth(2001, 5)).find(r => r.key === KEY);
  const series  = (await engine.evalDaily(FROM, TO))[KEY].series;
  return {
    monthly: monthly.computed,
    seriesSum: series.reduce((s, p) => s + (p.value || 0), 0),
    points: series.filter(p => p.value !== null).length,
  };
}

test('formula engine — shift handling', async (t) => {
  if (!(await reachable())) {
    t.skip('no database reachable');
    return;
  }

  t.after(async () => { await clean(); await db.pool?.end?.(); });

  await t.test('sanity: the fixture actually wires up some kWh sections', () => {
    assert.ok(SECTIONS > 0, 'total-power-kwh should read at least one power-cons field');
  });

  await t.test('a single day-shift row: monthly equals its own series', async () => {
    await clean();
    await insert('day');
    const { monthly, seriesSum, points } = await readBoth();
    assert.equal(points, 1, 'one reported day should give one series point');
    assert.equal(monthly, ONE_ROW_TOTAL);
    assert.equal(monthly, seriesSum);
  });

  /* The regression itself. Before the fix this asserted 2x ONE_ROW_TOTAL on
     the monthly side against 1x on the series side. */
  await t.test('day + night on one date do not double-count, and do not diverge', async () => {
    await clean();
    await insert('day');
    await insert('night');
    const { monthly, seriesSum, points } = await readBoth();

    assert.equal(points, 1, 'two shifts of one date are still ONE calendar day');
    assert.equal(monthly, ONE_ROW_TOTAL,
      'two shifts carrying the same fact must not sum into a doubled day');
    assert.equal(monthly, seriesSum,
      'evalMonth and evalDaily must not disagree — misReport.js uses both');
  });

  await t.test("an 'all' shift row behaves like any other single day", async () => {
    await clean();
    await insert('all');
    const { monthly, seriesSum, points } = await readBoth();
    assert.equal(points, 1);
    assert.equal(monthly, ONE_ROW_TOTAL);
    assert.equal(monthly, seriesSum);
  });

  /* A later shift must not blank a reading an earlier shift supplied: the
     night row here carries the fields as empty strings, which num() reads as
     null. Last-write-wins on a null would erase the day. */
  await t.test('a later shift with blank fields does not erase an earlier reading', async () => {
    await clean();
    await insert('day');
    const blanks = {};
    for (const k of Object.keys(payload(PER_SECTION))) blanks[k] = '';
    await db.query(
      `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
       VALUES ('power-cons', $1, 'night', $2, 'approved')`,
      [DATE, JSON.stringify(blanks)]
    );

    const { monthly, seriesSum } = await readBoth();
    assert.equal(monthly, ONE_ROW_TOTAL, 'blank night shift must not zero the day');
    assert.equal(monthly, seriesSum);
  });

  await t.test('drafts stay invisible to both paths', async () => {
    await clean();
    await db.query(
      `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
       VALUES ('power-cons', $1, 'day', $2, 'draft')`,
      [DATE, JSON.stringify(payload(PER_SECTION))]
    );
    const { monthly, points } = await readBoth();
    assert.equal(points, 0, 'a draft is not reported data');
    assert.equal(monthly, null);
  });
});
