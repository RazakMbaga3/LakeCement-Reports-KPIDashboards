/*
  The Daily Summary Report at the foot of the Executive Summary — the plant
  head's own morning MIS table (Mining / Stock / Production, ON DATE + MTD +
  YTD) rebuilt from the daily forms.

  Two through-lines:

    1. Same rule as kpi-dashboard.spec.js — every figure on screen must have
       come from the API. This section was added precisely because the page
       was carrying eleven illustrative cards; it must not reintroduce the
       problem in table form. A row the server flags unavailable has to
       render as an em dash and never as a number (least of all a 0: "Coal
       for CPP: 0 MT" and "Coal for CPP: not entered" mean opposite things
       to whoever reads it at 7am).

    2. It puts raw-material stock and quarry movements on the one page every
       role can open, so it must not become a side door around the access
       matrix.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');

/* Sections and the permission each one rides on — mirrors DSR_SECTION_GATE
   in kpi-data.js. A deliberate second copy, for the same reason
   fixtures/roles.js is one: this asserts the rendered UI honours the rule,
   not merely that one source file agrees with another. */
const STOCK_SECTIONS = ['Stores Ledger', 'Raw Mill Pile', 'Quarry Stockyard'];

async function openSummary(page, role) {
  await loginAs(page, role);
  await page.goto('/index.html');
  await page.waitForSelector('#dsr-grid .dsr-card', { timeout: 20_000 });
}

test.describe('Daily Summary Report (index.html)', () => {
  test('every figure on screen came from the API', async ({ page }) => {
    const errors = collectErrors(page);
    await openSummary(page, 'admin');

    const check = await page.evaluate(async () => {
      const date = document.getElementById('dsr-date').value;
      const payload = await NyatiAPI.getDailySummary(date);

      /* Flatten what the server said, then what the DOM shows, and compare
         cell for cell. */
      /* Formatted with the page's own dsrNum: the claim under test is that
         the right value lands in the right cell, not how a number is
         punctuated. Position-for-position comparison still catches a
         column or row that renders out of order. */
      const expected = [];
      for (const sec of dsrVisibleSections(payload)) {
        for (const row of sec.rows) {
          for (const col of sec.columns) {
            const v = row.available === false ? null : dsrNum(row[col]);
            expected.push(v === null ? '—' : v);
          }
        }
      }

      const shown = [];
      for (const card of document.querySelectorAll('#dsr-grid .dsr-card')) {
        for (const tr of card.querySelectorAll('tbody tr')) {
          for (const td of [...tr.querySelectorAll('td')].slice(1)) {
            /* Strip the below-min / above-max badge; it is a verdict on the
               figure, not part of it. */
            const flag = td.querySelector('.dsr-flag');
            shown.push(td.textContent.replace(flag ? flag.textContent : '', '').trim());
          }
        }
      }
      return { expected, shown, date };
    });

    expect(check.date, 'the section must state which day it is showing').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(check.shown).toEqual(check.expected);
    expect(errors(), 'uncaught errors while rendering the daily summary').toEqual([]);
  });

  test('a row the server cannot source shows an em dash, never a zero', async ({ page }) => {
    await openSummary(page, 'admin');

    const bad = await page.evaluate(async () => {
      const payload = await NyatiAPI.getDailySummary(document.getElementById('dsr-date').value);
      const offenders = [];
      for (const sec of dsrVisibleSections(payload)) {
        for (const row of sec.rows) {
          if (row.available !== false) continue;
          for (const col of sec.columns) {
            if (row[col] != null) offenders.push(sec.key + '/' + row.key + '/' + col);
          }
        }
      }
      /* Nothing in the DOM may show a number on an unavailable row either. */
      for (const tr of document.querySelectorAll('#dsr-grid .dsr-row-na')) {
        for (const td of [...tr.querySelectorAll('td')].slice(1)) {
          if (/\d/.test(td.textContent)) offenders.push('rendered: ' + tr.textContent.trim().slice(0, 40));
        }
      }
      return offenders;
    });

    expect(bad, 'unavailable rows carrying a value').toEqual([]);
  });

  test('stock is hidden from roles without store.rawmat, shown to those with it', async ({ page }) => {
    /* sales can open the Executive Summary but has store.rawmat = null. */
    await openSummary(page, 'sales');
    const salesTitles = await page.locator('#dsr-grid .dsr-card-title').allTextContents();
    for (const section of STOCK_SECTIONS) {
      expect(salesTitles.join(' | '), `sales must not see ${section}`).not.toContain(section);
    }
    expect(salesTitles.join(' | '), 'sales must not see the Quarry movements').not.toContain('Mining Report');
    expect(salesTitles.join(' | '), 'Production is not newly restricted').toContain('Production Report');

    await openSummary(page, 'md');
    const mdTitles = (await page.locator('#dsr-grid .dsr-card-title').allTextContents()).join(' | ');
    for (const section of STOCK_SECTIONS) {
      expect(mdTitles, `md must see ${section}`).toContain(section);
    }
  });

  test('no illustrative card is left in the live rows', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

    const summary = html.slice(html.indexOf('id="dept-summary"'),
                               html.indexOf('</section><!-- /#dept-summary -->'));
    const live = summary.slice(0, summary.indexOf('<details class="smry-pending-panel"'));

    expect(live.match(/sk-illustrative/g) || [],
      'an illustrative card is back in the live rows — it belongs in the pending panel').toEqual([]);
    expect(summary).toContain('smry-pending-panel');
  });
});
