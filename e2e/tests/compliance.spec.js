/*
  compliance.spec.js — the Compliance Master page (compliance.html) in a
  real browser, against the real API.

  Sandbox: the spec creates its own records through the API, every title
  prefixed "E2E ", owned by P&M (e2e_pm = HOD) — global-teardown.js removes
  every compliance record a harness account created, with its documents.
  Assertions are relative (the page equals the API for the same user), so
  real compliance data in the database does not break them.

  Proves:
    • the dashboard's tiles and pivot are the API's numbers, not hardcoded;
    • a pivot count opens the Register filtered to exactly those records;
    • ?item= deep-links straight into the record drawer;
    • an officer can upload a certificate but cannot edit; the HOD's verify
      flips "Not yet verified" off;
    • md reads every department with no Add button; another department
      cannot open a P&M record;
    • the register becomes cards at phone width; no console errors.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');

const API = 'http://localhost:5000/api';
const PDF = Buffer.from('%PDF-1.4\n% e2e certificate\ntrailer << >>\n%%EOF\n');

async function token(page) { return page.evaluate(() => getAuthToken()); }
async function api(page, method, path, body) {
  const t = await token(page);
  return page.evaluate(async ([m, url, b, tk]) => {
    const r = await fetch(url, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, API + path, body, t]);
}
const iso = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

let overdueId, dueId;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAs(page, 'pm');
  const mk = async (title, validTo) => {
    const r = await api(page, 'POST', '/compliance/items', { kind: 'validity', title, agency: 'OSHA', valid_from: iso(-400), valid_to: validTo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.item.id;
  };
  overdueId = await mk('E2E Overhead crane certificate', iso(-20));
  dueId = await mk('E2E Air receiver examination', iso(10));
  // Created by an HOD of the owning department, so they arrive verified;
  // un-verify one through the DB-free route: an admin transfer back and
  // forth would be heavier, so the officer test below verifies a fresh one.
  await page.close();
});

test('dashboard tiles and pivot are the API\'s own numbers', async ({ page }) => {
  const errors = collectErrors(page);
  await loginAs(page, 'pm');
  const sum = (await api(page, 'GET', '/compliance/summary?timeframe=all')).body;
  await page.goto('/compliance.html');
  await expect(page.locator('#cm-tiles .cm-tile').first()).toBeVisible();
  const tileVal = async (k) => page.locator('#cm-tiles .cm-tile', { hasText: k }).first().locator('.cm-tile-v').innerText();
  expect(await tileVal('Overdue')).toBe(String(sum.tiles.overdue));
  expect(await tileVal('Due')).toBe(String(sum.tiles.due));
  expect(sum.scope).toBe('pm');
  await expect(page.locator('#cm-pivot tr.n-total')).toContainText(String(sum.pivot.totals.total));
  await expect(page.locator('#cm-chart')).toBeVisible();
  await page.screenshot({ path: 'screenshots/compliance-dashboard.png', fullPage: true });
  expect(errors()).toEqual([]);
});

test('a pivot count opens the Register filtered to those records', async ({ page }) => {
  await loginAs(page, 'pm');
  await page.goto('/compliance.html');
  await page.locator('#cm-pivot [data-go*="status=overdue"]').first().click();
  await expect(page.locator('#cm-register')).toBeVisible();
  await expect(page.locator('#r-status')).toHaveValue('overdue');
  const chips = page.locator('#r-table tbody tr .n-chip.is-bad');
  await expect(chips.first()).toBeVisible();
  const rows = await page.locator('#r-table tbody tr').count();
  expect(await chips.count()).toBe(rows);
  await expect(page.locator('#r-table')).toContainText('E2E Overhead crane certificate');
});

test('?item= deep-links into the record drawer', async ({ page }) => {
  await loginAs(page, 'pm');
  await page.goto('/compliance.html?item=' + overdueId);
  await expect(page.locator('#d-drawer')).toBeVisible();
  await expect(page.locator('#d-title')).toHaveText('E2E Overhead crane certificate');
  await expect(page.locator('.cm-step.on.overdue')).toBeVisible();
  await page.screenshot({ path: 'screenshots/compliance-record.png' });
});

test('an officer uploads the renewed certificate but cannot edit the record', async ({ page }) => {
  await loginAs(page, 'pm_officer');
  await page.goto('/compliance.html?item=' + overdueId);
  await expect(page.locator('#d-drawer')).toBeVisible();
  await expect(page.locator('[data-act=edit]')).toHaveCount(0);
  await page.locator('[data-act=renew]').click();
  await page.setInputFiles('#ff-file', { name: 'crane-certificate.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.fill('#ff-valid_to', iso(365));
  await page.locator('#f-submit').click();
  await expect(page.locator('#cm-flash')).toContainText('renewed');
  await expect(page.locator('.cm-step.on.active')).toBeVisible();
  await page.locator('[data-dtab=docs]').click();
  await expect(page.locator('#d-tab')).toContainText('crane-certificate.pdf');
  await expect(page.locator('#d-tab')).toContainText('v1');
});

test('the HOD verifies a record and the "not yet verified" flag clears', async ({ page }) => {
  await loginAs(page, 'pm');
  // A transfer un-verifies (the receiving department has not confirmed it);
  // moving it to P&M from elsewhere needs admin, so use an admin round trip.
  const adminPage = await page.context().browser().newPage();
  await loginAs(adminPage, 'admin');
  expect((await api(adminPage, 'POST', `/compliance/items/${dueId}/transfer`, { owner_role: 'ei', reason: 'e2e round trip' })).status).toBe(200);
  expect((await api(adminPage, 'POST', `/compliance/items/${dueId}/transfer`, { owner_role: 'pm', reason: 'e2e round trip back' })).status).toBe(200);
  await adminPage.close();
  await page.goto('/compliance.html?item=' + dueId);
  await expect(page.locator('#d-flags')).toContainText('Not yet verified');
  page.once('dialog', d => d.accept());
  await page.locator('[data-act=verify]').click();
  await expect(page.locator('#cm-flash')).toContainText('Verified');
  await expect(page.locator('#d-flags')).not.toContainText('Not yet verified');
});

test('md reads every department and cannot add; another department cannot open a P&M record', async ({ page, browser }) => {
  await loginAs(page, 'md');
  await page.goto('/compliance.html');
  await expect(page.locator('#f-dept-wrap')).toBeVisible();
  await expect(page.locator('#cm-add')).toBeHidden();
  const ei = await browser.newPage();
  await loginAs(ei, 'ei');
  await ei.goto('/compliance.html?item=' + overdueId);
  await expect(ei.locator('#d-title')).toHaveText('Record not found');
  await ei.close();
});

test('at phone width the register is a list of cards', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await loginAs(page, 'pm');
  await page.goto('/compliance.html?tab=register');
  await expect(page.locator('#r-table tbody tr').first()).toBeVisible();
  await expect(page.locator('#r-table thead')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'screenshots/compliance-register-360.png', fullPage: true });
});
