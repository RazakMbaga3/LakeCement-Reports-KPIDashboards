/*
  stores-odoo-feed.spec.js — the Odoo stores feed, in a real browser.

  Covers the two surfaces added 2026-10-01:
    purchases.html            Goods Received / Diesel Issued / Stock Valuation
    forms/materials-form.html "Fill from Odoo" prefill

  Asserts that what is on SCREEN matches what the API returned — the house
  rule for this harness. A table that renders but shows the wrong tonnage
  passes a smoke test and fails this one.

  These read rm_gate_entries / rm_grn_lines / stores_issues. They are
  skipped (not failed) when those tables are empty, because an empty feed
  is a legitimate state on a fresh database and a red suite nobody can act
  on is worse than a skip that says why.
*/
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

/* purchases.html is gated on PURCHASE_VIEW_ROLES, which deliberately
   EXCLUDES admin (it is the IT/system account, not a commercial one), so
   these use the purchase role. Using admin here is what first surfaced the
   403 the stores routes used to return for exactly that department. */

/* The day the sample data covers — the same window every verification in
   this thread used, so a failure here is a code change, not a data change. */
const SAMPLE_DAY = '2026-09-15';

async function apiGet(page, path) {
  return page.evaluate(async (p) => {
    const token = sessionStorage.getItem('lcl_mis_token');
    const base = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? 'http://localhost:5000/api' : '/api';
    const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + token } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, path);
}

/* Drive the page to the sample DAY via the custom range, not the month
   picker. Month mode asks for the last day of the month, and the sample
   data is 13-15 Sep — so a September month view correctly shows nothing,
   which is the page behaving properly and the test asking the wrong
   question. The custom range makes the day explicit. */
async function selectSampleDay(page) {
  await page.selectOption('#pd-mode', 'custom');
  await page.fill('#pd-from', SAMPLE_DAY);
  await page.fill('#pd-to', SAMPLE_DAY);
  await page.dispatchEvent('#pd-to', 'change');
  await page.waitForFunction(
    () => document.querySelectorAll('#sv-receipts tr').length > 0,
    { timeout: 25000 });
}

test.describe('Odoo stores feed', () => {
  test('purchases.html renders receipts, diesel and valuation from the API', async ({ page }) => {
    await loginAs(page, 'purchase');
    await page.goto('/purchases.html');

    const api = await apiGet(page, `/stores/raw-material?date=${SAMPLE_DAY}`);
    expect(api.status, 'raw-material endpoint should answer').toBe(200);
    test.skip(!api.body.rows.length, 'no synced gate entries for the sample day');

    await selectSampleDay(page);

    const rowCount = await page.locator('#sv-receipts tr').count();
    expect(rowCount, 'a row per mapped material/supplier').toBe(api.body.rows.length);

    /* Every tonnage on screen must be one the API actually returned.
       Compared NUMERICALLY, not as strings: the page formats through
       toLocaleString with maximumFractionDigits:1, so 287.62 MT correctly
       renders as "287.6". Asserting on the raw string would be testing the
       formatter's rounding, not whether the right figure reached the page. */
    const onScreen = await page.locator('#sv-receipts tr').evaluateAll(
      trs => trs.map(tr => Number(tr.children[3].textContent.replace(/,/g, '').trim())));
    for (const r of api.body.rows) {
      expect(onScreen.some(v => Math.abs(v - r.mt) < 0.05),
        `received ${r.mt} MT for ${r.label} should appear (saw ${onScreen.join(', ')})`).toBe(true);
    }

    /* Coal must carry its Kiln/CPP destination, since that split is the
       whole reason the mapping layer exists. */
    const coal = api.body.rows.filter(r => r.destination);
    if (coal.length) {
      const badges = await page.locator('#sv-receipts .sv-dest').evaluateAll(
        els => els.map(e => e.textContent.trim()));
      for (const c of coal) {
        expect(badges, `${c.label} should show its destination`)
          .toContain(c.destination === 'cpp' ? 'CPP' : 'Kiln');
      }
    }

    const diesel = await apiGet(page, `/stores/issues?date=${SAMPLE_DAY}&product=FUEL%20DIESEL`);
    if (diesel.body && diesel.body.by_department.length) {
      await expect(page.locator('#sv-diesel tr')).toHaveCount(diesel.body.by_department.length);
    }

    /* Nothing may be left in a permanent loading state. */
    await expect(page.locator('#sv-recv-empty')).toBeHidden();
  });

  test('an unmatched supplier is surfaced, never folded into a mapped row', async ({ page }) => {
    await loginAs(page, 'purchase');
    await page.goto('/purchases.html');
    const api = await apiGet(page, `/stores/raw-material?date=${SAMPLE_DAY}`);
    test.skip(api.status !== 200, 'endpoint unavailable');

    await selectSampleDay(page);

    const box = page.locator('#sv-exceptions');
    if (api.body.unassigned.length) {
      await expect(box, 'unmatched trucks must be visible').toBeVisible();
      await expect(box).toContainText('Not matched');
    } else {
      /* The panel must stay hidden rather than render an empty box — an
         empty warning frame reads as a broken page. */
      await expect(box).toBeHidden();
    }
  });

  test('materials form fills received + pending GRN from Odoo', async ({ page }) => {
    await loginAs(page, 'stores');
    await page.goto('/forms/materials-form.html');

    const api = await apiGet(page, `/stores/raw-material?date=${SAMPLE_DAY}`);
    test.skip(api.status !== 200 || !api.body.rows.length, 'no synced data for the sample day');

    await page.fill('[data-field="date"]', SAMPLE_DAY);
    await page.click('#mf-odoo-fill');
    await expect(page.locator('#mf-odoo-note')).toContainText('filled from Odoo', { timeout: 30000 });

    /* Each mapped row's rcvd cell should now hold the API's tonnage, and
       carry the data-odoo marker the legend explains. */
    for (const r of api.body.rows) {
      const cell = page.locator(`[data-field="${r.row}_rcvd"]`);
      if (await cell.count() === 0) continue;      // row not on this form
      const val = await cell.inputValue();
      expect(Number(val), `${r.row} received`).toBeCloseTo(r.mt, 2);
      await expect(cell).toHaveAttribute('data-odoo', '1');
    }
  });

  test('a figure the officer already typed is never overwritten', async ({ page }) => {
    await loginAs(page, 'stores');
    await page.goto('/forms/materials-form.html');
    const api = await apiGet(page, `/stores/raw-material?date=${SAMPLE_DAY}`);
    test.skip(api.status !== 200 || !api.body.rows.length, 'no synced data');

    /* Pick the first row that has a non-zero tonnage AND actually exists on
       this form. Taking rows[0] blindly lands on industrial_clay, which the
       Raw Material Report has no row for (a known gap carried over from the
       integration plan), and the test then skips without proving anything. */
    let target = null, cell = null;
    for (const r of api.body.rows.filter(x => x.mt > 0)) {
      const c = page.locator(`[data-field="${r.row}_rcvd"]`);
      if (await c.count() > 0) { target = r; cell = c; break; }
    }
    test.skip(!target, 'no non-zero receipt maps to a row on this form');

    await page.fill('[data-field="date"]', SAMPLE_DAY);
    await cell.fill('999.99');                       // the officer's own figure
    await page.click('#mf-odoo-fill');
    await expect(page.locator('#mf-odoo-note')).toContainText('filled from Odoo', { timeout: 30000 });

    expect(await cell.inputValue(), 'a typed figure must survive the prefill').toBe('999.99');
    await expect(page.locator('#mf-odoo-note')).toContainText('kept');
  });
});
