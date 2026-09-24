/*
  forms/pile-quality-form.html — the live engine.

  Until 2026-09-24 this form looked calculated and was not. The two Diff
  columns were the literals "0" and "0.00"; the Σ totals row carried ids
  (tot-trips-qc, diff-wt …) for an engine nobody wrote; and the tiles above the
  log — "Total Pile Weight 3,702.2 MT", "Trip Reconciliation 169 / 169",
  "Weight Reconciliation 0.00", all badged Formula — were figures typed into
  the markup from one April day, so a blank new day announced a perfect
  weighbridge match to the chemist standing at the pile. Below the log, two
  whole sections were a frozen 1–20 May 2026 mockup (HG 2,018.50 MT, a table
  totalling 50,635.93 MT) with no input or code behind a single figure.

  What these tests hold, and why each is a test rather than a code comment:

    - LIVE: every derived figure updates on the keystroke, WITHOUT leaving the
      field. Playwright's fill() types and never blurs, so a regression to
      change/blur wiring fails here. (The CaO highlight itself used to fire on
      blur, which is why a chemist typing 41.7 saw nothing until they tabbed.)
    - HONEST: a blank day shows dashes, never a plausible number.
    - PHONE: mobile-entry.js MOVES inputs into cards, so an engine that finds
      "the 5th cell of the row" works on a desktop and silently does nothing at
      the handset the chemist actually uses. The whole flow is repeated at 390px.
    - COMPLETE: a row added with "Add Row" reconciles like the other 18, and is
      visible in the card view (it used to exist only in the hidden table).
    - GUARDED AT SOURCE: the markup itself is checked, so a figure typed back
      into the HTML fails the suite even if the API happens to answer.

  Writes go to a 1999 sandbox date and are cleaned up.
*/
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const D = '1999-08-05';

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
}
test.beforeEach(cleanup);
test.afterAll(cleanup);

async function openBlankDay(page) {
  const errors = collectErrors(page);
  await loginAs(page, 'production');
  await page.goto('/forms/pile-quality-form.html');
  await page.waitForLoadState('networkidle');
  // A sandbox day, so nothing real is ever read or written.
  await page.evaluate(d => {
    const el = document.querySelector('[data-field="date"]');
    el.value = d;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, D);
  await page.waitForTimeout(1200);
  return errors;
}

const tile = (page, k) => page.locator(`[data-pq="${k}"]`);
const note = (page, k) => page.locator(`[data-pq-note="${k}"]`);
const calc = (page, kind, row) => page.locator(`[data-pcalc="${kind}"][data-prow="${row}"]`);
const put = (page, row, col, v) => page.locator(`input[data-prow="${row}"][data-pcol="${col}"]`).fill(String(v));
const hasClass = (loc, c) => loc.evaluate((e, k) => e.classList.contains(k), c);
const cardOf = (loc, c) => loc.evaluate((e, k) => e.closest('.kt').classList.contains(k), c);

/* The reconciliation + CaO flow, run twice: at desktop width and in the phone
   card view. Attribute-bound, so the same locators must work in both. */
async function exerciseEngine(page, { addRow }) {
  // ── trips: live, no blur ──
  await put(page, 1, 'tqc', 15);
  await put(page, 1, 'twb', 14);
  await expect(calc(page, 'trips', 1), 'Diff Trips updates on the keystroke').toHaveText('+1');
  expect(await hasClass(calc(page, 'trips', 1), 'ooc'), 'a QC/WB mismatch turns the cell red').toBe(true);
  await expect(tile(page, 'trips')).toHaveText('15 / 14');
  await expect(note(page, 'trips')).toContainText('apart');
  await expect(page.locator('#tot-trips-qc')).toHaveText('15');
  await expect(page.locator('#tot-trips-wb')).toHaveText('14');
  await expect(page.locator('#diff-trips')).toHaveText('+1');

  await put(page, 1, 'twb', 15);
  await expect(calc(page, 'trips', 1)).toHaveText('0');
  expect(await hasClass(calc(page, 'trips', 1), 'ooc'), 'agreeing figures clear the red').toBe(false);
  await expect(note(page, 'trips')).toContainText('Zero discrepancy');

  // ── weights ──
  await put(page, 1, 'wqc', 307.22);
  await expect(calc(page, 'weight', 1),
    'a lone QC weight is "awaiting WB", not a diff against zero').toHaveText('—');
  await put(page, 1, 'wwb', 306.72);
  await expect(calc(page, 'weight', 1)).toHaveText('+0.50');
  await expect(tile(page, 'wdiff')).toHaveText('+0.50');
  await expect(note(page, 'wdiff')).toContainText('over weighbridge');
  await expect(tile(page, 'total-wt'), 'total pile weight is the weighbridge total').toHaveText('306.7');
  await put(page, 1, 'wwb', 307.22);
  await expect(calc(page, 'weight', 1)).toHaveText('0.00');
  await expect(tile(page, 'wdiff')).toHaveText('0.00');

  // ── CaO: highlight and average while typing ──
  await put(page, 1, 'cao', 41.7);
  expect(await hasClass(page.locator('input[data-prow="1"][data-pcol="cao"]'), 'ooc'),
    'CaO below 45 goes red as you type, not on blur').toBe(true);
  await expect(tile(page, 'cao-avg')).toHaveText('41.70%');
  expect(await cardOf(tile(page, 'cao-avg'), 'watch'), '41.70 is 92.7% of spec — watch, not concern').toBe(true);

  await put(page, 2, 'cao', 48.3);
  await expect(tile(page, 'cao-avg')).toHaveText('45.00%');
  expect(await cardOf(tile(page, 'cao-avg'), 'on-track')).toBe(true);
  await expect(note(page, 'cao-avg')).toContainText('1 of 2 readings below 45.00');
  await expect(page.locator('#avg-cao'), 'the Σ row average agrees with the tile').toHaveText('45.00');
  await expect(page.locator('#pile-samples')).toHaveText('2 samples');

  if (!addRow) return;

  // ── an added row reconciles like the others, and is reachable ──
  await page.locator('button', { hasText: 'Add Row' }).click();
  await put(page, 19, 'tqc', 10);
  await put(page, 19, 'twb', 9);
  await expect(calc(page, 'trips', 19), 'an added row is wired like the first 18').toHaveText('+1');
  await put(page, 19, 'cao', 40);
  expect(await hasClass(page.locator('input[data-prow="19"][data-pcol="cao"]'), 'ooc')).toBe(true);
  /* The registry's pile-cao-avg KPI counts cao_h1..cao_h18 only. Counting a
     19th row here would make this form disagree with the dashboard it feeds,
     so it is left out of the average — and the tile says so. */
  await expect(note(page, 'cao-avg')).toContainText('1 added row not in the KPI average');
  await expect(tile(page, 'cao-avg')).toHaveText('45.00%');
}

test('a blank day shows dashes, not a plausible number', async ({ page }) => {
  const errors = await openBlankDay(page);
  const body = await page.evaluate(() => document.body.innerText);
  for (const banned of ['44.46', '3,702', '169 / 169', '2,018.50', '1,683.70', '20 May 2026', '50,635', 'perfect match']) {
    expect(body, `"${banned}" is a figure from the old mockup and must not be on a blank day`).not.toContain(banned);
  }
  for (const k of ['total-wt', 'trips', 'wdiff', 'cao-avg']) {
    await expect(tile(page, k), `tile ${k}`).toHaveText('—');
  }
  await expect(calc(page, 'trips', 1)).toHaveText('—');
  await expect(calc(page, 'weight', 1)).toHaveText('—');
  await expect(page.locator('.pq-nosource'),
    'Sections 2 and 3 have no data source and must say so').toHaveCount(2);
  expect(errors(), 'uncaught errors').toEqual([]);
});

test('every derived figure updates on the keystroke, without leaving the field', async ({ page }) => {
  const errors = await openBlankDay(page);
  await exerciseEngine(page, { addRow: true });
  expect(errors(), 'uncaught errors').toEqual([]);
});

test('the same engine works in the phone card view, where inputs are moved into cards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openBlankDay(page);
  await expect(page.locator('body'), 'a 390px viewport must be in the card view').toHaveClass(/me-view-cards/);
  await exerciseEngine(page, { addRow: true });
  expect(errors(), 'uncaught errors').toEqual([]);
});

test('the markup ships no figure and every log row is tagged for the engine', async () => {
  /* Checked against the file, not the rendered page. A rendered assertion
     passes whenever the API happens to answer; this fails the moment someone
     types a number back into the HTML, or adds a log row without tagging it —
     which would be a row that silently never reconciles. */
  const html = fs.readFileSync(path.join(__dirname, '../../forms/pile-quality-form.html'), 'utf8');

  const values = [...html.matchAll(/<div class="kt-val[^"]*"[^>]*>([^<]*)<\/div>/g)]
    .map(m => m[1].trim()).filter(v => v && !/^(—|&mdash;)$/.test(v));
  expect(values, 'a .kt-val ships with a figure').toEqual([]);

  const grades = [...html.matchAll(/<div class="gc-(?:qty|pct)[^"]*">([^<]*)<\/div>/g)]
    .map(m => m[1].trim()).filter(v => v && !/^(—|&mdash;)$/.test(v));
  expect(grades, 'a grade-summary figure is back in Section 2').toEqual([]);

  const logStart = html.indexOf('id="pile-log-tbl"');
  const log = html.slice(logStart, html.indexOf('<!-- ── TOTALS ── -->'));
  expect(log.match(/\svalue="/g) || [], 'a baked-in value is back in the pile log').toEqual([]);
  expect((log.match(/data-pcol="/g) || []).length, '18 rows x 8 tagged inputs').toBe(144);
  expect((log.match(/data-pcalc="/g) || []).length, '18 rows x 2 computed cells').toBe(36);

  expect(html, 'a dated title is back on a section with no date').not.toMatch(/Grade Summary\s*—\s*\d/);
  expect(html).not.toMatch(/MTD Limestone Quantity Summary\s*—\s*[A-Z]/);
});
