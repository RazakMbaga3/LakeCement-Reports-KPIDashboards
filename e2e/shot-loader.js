/*
  shot-loader.js — capture the loader's step checklist mid-run.

  Usage (from e2e/):  SHOT_USER=... SHOT_PASS=... node shot-loader.js
*/
const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'screenshots');
const BASE = 'http://localhost:3000';
const USER = process.env.SHOT_USER;
const PASS = process.env.SHOT_PASS;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  const res = await page.evaluate(([u, p]) => window.login(u, p), [USER, PASS]);
  if (!res || !res.ok) { console.log('LOGIN FAILED:', res && res.error); await browser.close(); process.exit(2); }

  await page.goto(BASE + '/purchases.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.LCLoader && window.LCLoader.done && window.LCLoader.done());
  await page.waitForTimeout(700);

  // Mid-run state: one done with a note, one running, two pending.
  await page.evaluate(() => {
    window.LCLoader.caption('Pulling the last 7 days from Odoo…');
    window.LCLoader.steps(['Gate entries', 'GRN register', 'Material issues', 'Refreshing the page']);
    window.LCLoader.step(0, 'ok', '208 rows');
    window.LCLoader.step(1, 'run');
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'loader-steps-running.png') });
  console.log('captured running state');

  // Failure state: the non-colour cue has to be visible too.
  await page.evaluate(() => {
    window.LCLoader.step(1, 'fail', 'timed out');
    window.LCLoader.step(2, 'run');
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'loader-steps-failed.png') });
  console.log('captured failure state');

  await browser.close();
  console.log('wrote to', OUT);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
