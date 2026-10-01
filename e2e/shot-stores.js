/*
  shot-stores.js — screenshot the two Odoo stores surfaces, logged in as a
  real role, so the rendered result can be looked at rather than inferred
  from an API response.

  Usage (from e2e/):  node shot-stores.js [YYYY-MM-DD]
  Writes into e2e/screenshots/.
*/
const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const DAY = process.argv[2] || new Date().toISOString().slice(0, 10);
const OUT = path.join(__dirname, 'screenshots');
const BASE = 'http://localhost:3000';

/* Real accounts, not the e2e_* harness ones: those are created and deleted
   by global-setup/teardown, so they do not exist outside a test run. */
const USER = process.env.SHOT_USER || 'stores';
const PASS = process.env.SHOT_PASS || 'Stores@2026';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  page.on('console', m => { if (m.type() === 'error') console.log('  [console error]', m.text().slice(0, 160)); });

  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  const res = await page.evaluate(([u, p]) => window.login(u, p), [USER, PASS]);
  if (!res || !res.ok) {
    console.log('LOGIN FAILED for', USER, '->', res && res.error);
    await browser.close();
    process.exit(2);
  }
  console.log('logged in as', USER, '/ role', res.user && res.user.role);

  // ── Purchases dashboard ────────────────────────────────────────────
  await page.goto(BASE + '/purchases.html', { waitUntil: 'domcontentloaded' });
  /* Fill the dates BEFORE switching mode. periodChanged() bails out when a
     custom range is half-filled, so selecting the mode first fires a change
     that does nothing and leaves the page on its previous (month) query. */
  /* The cross-page loader raises a full-screen cover and the purchase
     dashboard's own Odoo call can hold it for 30s+, during which every
     control is unclickable. Release it before driving the page. */
  await page.evaluate(() => window.LCLoader && window.LCLoader.done && window.LCLoader.done());
  await page.selectOption('#pd-mode', 'custom');     // reveals the two date inputs
  await page.waitForSelector('#pd-from', { state: 'visible', timeout: 15000 });
  await page.fill('#pd-from', DAY);
  await page.fill('#pd-to', DAY);
  /* One change AFTER both ends are set: periodChanged() bails out on a
     half-filled custom range, so firing it mid-fill leaves the page on its
     previous (month) query — which is how the first capture ended up
     showing 2026-10-31. */
  await page.dispatchEvent('#pd-to', 'change');
  await page.waitForFunction(
    () => document.querySelectorAll('#sv-receipts tr').length > 0,
    { timeout: 30000 }).catch(() => console.log('  (receipts table stayed empty)'));
  await page.waitForTimeout(1200);

  const rows = await page.locator('#sv-receipts tr').count();
  const diesel = await page.locator('#sv-diesel tr').count();
  const val = await page.locator('#sv-valuation tr').count();
  console.log(`purchases.html: receipts=${rows} diesel=${diesel} valuation=${val}`);

  await page.screenshot({ path: path.join(OUT, 'purchases-full.png'), fullPage: true });
  /* Element screenshot of the receipts card, scrolled into view first —
     taking it blind times out when the card sits below the fold. */
  const sec = page.locator('#sv-receipts').locator('xpath=ancestor::div[contains(@class,"in-card")]').first();
  if (await sec.count()) {
    await sec.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    await sec.screenshot({ path: path.join(OUT, 'purchases-receipts.png'), timeout: 15000 })
      .catch(e => console.log('  (card screenshot skipped: ' + e.message.slice(0, 60) + ')'));
  }

  // ── Raw Material form, after a Fill from Odoo ──────────────────────
  await page.goto(BASE + '/forms/materials-form.html', { waitUntil: 'domcontentloaded' });
  await page.fill('[data-field="date"]', DAY);
  await page.click('#mf-odoo-fill');
  await page.waitForSelector('#mf-odoo-note.is-ok, #mf-odoo-note.is-warn, #mf-odoo-note.is-err',
    { timeout: 40000 }).catch(() => console.log('  (prefill note never settled)'));
  await page.waitForTimeout(800);
  console.log('materials note:', (await page.locator('#mf-odoo-note').textContent() || '').trim().slice(0, 180));
  await page.screenshot({ path: path.join(OUT, 'materials-filled.png'), fullPage: true });

  await browser.close();
  console.log('\nwrote screenshots to', OUT);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
