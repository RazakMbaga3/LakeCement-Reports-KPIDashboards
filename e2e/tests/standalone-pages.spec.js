/*
  The five standalone KPI & Analytics pages.

  Each must load clean, render something real, and — where it falls back off
  today because the data stops earlier — say so on screen rather than showing
  an empty page that reads as broken.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const PAGES = [
  { url: '/analytics.html',    title: /Trend Analytics/i, stale: '#an-stale' },
  { url: '/completeness.html', title: /Entry Completeness/i, stale: '#cp-stale' },
  { url: '/balance.html',      title: /Material & Power Balance/i, stale: '#bl-stale' },
  { url: '/insights.html',     title: /Operational Insights/i, stale: '#in-stale' },
  { url: '/reliability.html',  title: /Equipment Reliability/i, stale: '#rl-stale' },
];

let LAST_DATA_DATE = null;
test.beforeAll(async () => {
  const { rows } = await pool.query('SELECT MAX(record_date)::text AS last FROM daily_reports');
  LAST_DATA_DATE = rows[0] && rows[0].last;
});

for (const p of PAGES) {
  test(`${p.url} loads clean`, async ({ page }) => {
    const errors = collectErrors(page);
    await loginAs(page, 'admin');
    await page.goto(p.url);
    await expect(page).toHaveTitle(p.title);
    await expect(page.locator('#app-sidebar')).toBeVisible();
    /* Every page that can fall back off today must carry the banner element,
       even when it is hidden — a missing one means the fallback silently
       cannot report itself. */
    if (p.stale) await expect(page.locator(p.stale)).toHaveCount(1);
    await page.waitForLoadState('networkidle');
    expect(errors(), `uncaught errors on ${p.url}`).toEqual([]);
  });
}

test('S7: pages whose data stops before today say so and still show data', async ({ page }) => {
  const today = new Date();
  const p2 = n => (n < 10 ? '0' : '') + n;
  const todayIso = today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate());
  test.skip(!LAST_DATA_DATE || LAST_DATA_DATE >= todayIso,
    'the database has data for today — nothing to fall back from');

  await loginAs(page, 'admin');

  // Balance — a single-day page: must land on the last day with data.
  await page.goto('/balance.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#bl-stale')).toBeVisible();
  await expect(page.locator('#bl-stale')).toContainText('most recent date with data');
  await expect(page.locator('#bl-content')).toBeVisible();
  await expect(page.locator('#bl-empty')).toBeHidden();

  // Reliability — a range page: the window slides back, so the Pareto fills.
  await page.goto('/reliability.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#rl-stale')).toBeVisible();
  await expect(page.locator('#rl-equip-tbody tr').first()).toBeVisible();
  await expect(page.locator('#kpi-avail')).not.toHaveText('—');

  // Insights — the small multiples must render rather than sit on empty states.
  await page.goto('/insights.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#in-stale')).toBeVisible();
  await expect(page.locator('#empty-downtime')).toBeHidden();

  // Trend Analytics — the trailing window slides back too.
  await page.goto('/analytics.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#an-stale')).toBeVisible();
  await expect(page.locator('#an-stale')).toContainText('most recent date with data');
});

test('reliability: equipment that never failed reads 100% available, not absent', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/reliability.html');
  await page.waitForLoadState('networkidle');

  const rows = await page.locator('#rl-equip-tbody tr').count();
  /* All seven sections of the stoppage matrix are always represented — a
     perfect month for the kiln used to remove it from the fleet average
     entirely, dragging plant availability DOWN. */
  expect(rows, 'every stoppage-matrix section must appear').toBe(7);

  const noFailures = await page.evaluate(() =>
    [...document.querySelectorAll('#rl-equip-tbody tr')]
      .map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()))
      .filter(c => c[2] === '0'));
  for (const c of noFailures) {
    expect(c[3], 'MTTR is undefined with no failures, not 0').toBe('—');
    expect(c[5], 'availability with no downtime is 100%').toContain('100.0%');
  }
});

test('balance: switching to an empty date clears the previous date\'s charts', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/balance.html');
  await page.waitForLoadState('networkidle');

  const before = await page.evaluate(() => {
    const c = document.getElementById('chart-clinker-own');
    return c ? c.toDataURL().length : 0;
  });
  test.skip(before === 0, 'no clinker chart rendered for the default date');

  /* forms/date-picker.js replaces the native popup and marks the input
     readonly, so set the value the way that picker does and fire the same
     change event the page listens for. */
  await page.evaluate(() => {
    const el = document.getElementById('bl-date');
    el.value = '1999-01-01';                       // guaranteed empty
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForLoadState('networkidle');

  await expect(page.locator('#bl-empty')).toBeVisible();
  await expect(page.locator('#bl-empty')).toContainText('No Production or Power Consumption data');
  await expect(page.locator('#fig-ste')).toHaveText('—');
});

test('completeness: the matrix renders a row per form type', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/completeness.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#cp-table tbody tr').first()).toBeVisible();
  const rows = await page.locator('#cp-table tbody tr').count();
  expect(rows, 'one row per configured form type').toBeGreaterThanOrEqual(10);
  await expect(page.locator('#cp-table tbody .cp-empty')).toHaveCount(0);
});
