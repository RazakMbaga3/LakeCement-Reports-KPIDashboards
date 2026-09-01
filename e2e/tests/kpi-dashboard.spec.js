/*
  index.html — the 9 KPI & Analytics department views.

  The through-line of every assertion here: a number on this dashboard must
  have come from the API. index.html used to ship 72 .achieved-tag and 48
  .not-tag cells with figures baked in at authoring time, so it opened showing
  a plausible, entirely fabricated month.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const DEPTS = ['summary', 'ei', 'production', 'mines', 'mechanical',
               'powerplant', 'packing', 'stores', 'minesworkshop'];

test.describe('KPI dashboard (index.html)', () => {
  test('loads with no page errors and lands on Executive Summary', async ({ page }) => {
    const errors = collectErrors(page);
    await loginAs(page, 'admin');
    await page.goto('/index.html');
    await expect(page.locator('#dept-summary')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors(), 'uncaught errors on load').toEqual([]);
  });

  test('S1: no fabricated status verdicts survive in the shipped HTML', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

    /* Mines Workshop is excluded from the kpi-data.js pipeline entirely and
       keeps its own figures; every other section must ship blank. */
    const wsStart = html.indexOf('id="dept-minesworkshop"');
    const pipeline = html.slice(0, wsStart);

    expect(pipeline.match(/achieved-tag/g) || [], 'hardcoded "Achieved" verdicts').toEqual([]);
    expect(pipeline.match(/class="status not-tag"/g) || [], 'hardcoded "Not Achieved" verdicts').toEqual([]);

    /* The Concerns strip must ship empty — its chips are built at runtime.
       (Match on markup, not on the old chip text: the comment explaining why
       the strip is dynamic legitimately describes what used to be there.) */
    const strip = html.slice(html.indexOf('id="smry-alerts"'), html.indexOf('period-strip'));
    expect(strip.match(/alert-dot/g) || [], 'pre-rendered Concerns chips').toEqual([]);
  });

  test('S1: every Concerns chip corresponds to a real KPI that missed its target', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    const check = await page.evaluate(async () => {
      const mo = +document.getElementById('month-select').value;
      const yr = document.getElementById('year-select').value;
      const calYear = fiscalPosToCalYear(calMonthToFiscalPos(mo), yr);
      const results = await NyatiAPI.evalFormulas(calYear, mo);
      const missed = results.filter(r => r.value != null && r.target != null &&
        signageAchieved(r.signage, r.value, r.target) === false);
      const chips = [...document.querySelectorAll('#smry-alerts .smry-alert-chip')]
        .map(el => el.textContent.trim());
      return { missedLabels: missed.map(r => r.label), chips };
    });

    if (!check.missedLabels.length) {
      expect(check.chips.join(' ')).toMatch(/No KPI missed its target|unavailable/);
      return;
    }
    /* Each chip must name a KPI the engine actually reports as missing. */
    for (const chip of check.chips) {
      if (/^\+\d+ more/.test(chip)) continue;
      expect(check.missedLabels.some(l => chip.includes(l)),
        `chip "${chip}" names no KPI the formula engine flagged`).toBe(true);
    }
  });

  test('S3: every rendered row reaches a defensible verdict', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    for (const dept of DEPTS.filter(d => d !== 'summary' && d !== 'minesworkshop')) {
      await page.evaluate(d => switchDept(d), dept);
      const bad = await page.evaluate(d => {
        const out = [];
        document.querySelectorAll(`#dept-${d} .kpi-table .data-row`).forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length < 19) return;
          const status = cells[18].textContent.trim();
          const sign   = cells[2].textContent.trim();
          if (!['Achieved', 'Not Achieved', 'No data', '—'].includes(status)) {
            out.push(cells[0].textContent.trim() + ' → unexpected status "' + status + '"');
          }
          /* A blank signage cell cannot produce a pass/fail verdict — this is
             the bug that made Quarry's tonnage rows and Power Plant's
             Maintenance Cost read "Not Achieved" unconditionally. */
          if (!sign && (status === 'Achieved' || status === 'Not Achieved')) {
            out.push(cells[0].textContent.trim() + ' → verdict "' + status + '" with no signage');
          }
        });
        return out;
      }, dept);
      expect(bad, `department ${dept}`).toEqual([]);
    }
  });

  test('S2: real kpi_monthly data reaches the screen (Quarry cost rows)', async ({ page }) => {
    /* The regression that motivated data-kpi-key: the 2026-08-01 Quarry rename
       orphaned six months of cost data still stored under mines-*. */
    const { rows } = await pool.query(
      `SELECT kpi_key, actual FROM kpi_monthly
       WHERE department='mines' AND year=2026 AND month=5
         AND kpi_key IN ('mines-maintenance-cost','mines-operational-cost')
       ORDER BY kpi_key`
    );
    test.skip(rows.length < 2, 'May 2026 quarry cost rows not present in this database');

    await loginAs(page, 'admin');
    await page.goto('/index.html?dept=mines');
    await page.selectOption('#month-select', '5');
    await page.selectOption('#year-select', '2026');
    await page.waitForLoadState('networkidle');

    for (const r of rows) {
      const shown = await page.evaluate(key => {
        const row = [...document.querySelectorAll('#dept-mines .data-row')]
          .find(tr => tr.dataset.kpiKey === key);
        return row ? row.querySelectorAll('td')[4].textContent.trim() : null;
      }, r.kpi_key);
      expect(shown, `${r.kpi_key} must render its stored value, not "No data"`).not.toBe('—');
      expect(shown).not.toBe('No data');
      expect(Number(String(shown).replace(/,/g, ''))).toBeCloseTo(Number(r.actual), 0);
    }
  });

  test('Executive Summary chips are recomputed after data loads', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    /* The chip percentage must equal a recount of what the tables actually
       show — it was previously derived before the fetch resolved, from the
       hardcoded HTML. */
    const mismatches = await page.evaluate(() => {
      const out = [];
      ['ei', 'production', 'mines', 'mechanical', 'powerplant', 'packing', 'stores'].forEach(d => {
        const sec = document.getElementById('dept-' + d);
        if (!sec) return;
        const a = sec.querySelectorAll('.achieved-tag').length;
        const n = sec.querySelectorAll('.not-tag').length;
        const expected = (a + n) > 0 ? Math.round((a / (a + n)) * 100) : 0;
        const el = document.getElementById('sc-pct-' + d);
        if (!el) return;
        const shown = parseInt(el.textContent, 10) || 0;
        if (shown !== expected) out.push(`${d}: chip ${shown}% vs recount ${expected}%`);
      });
      return out;
    });
    expect(mismatches).toEqual([]);
  });

  test("Today's Reports strip reflects the server, not this browser", async ({ page }) => {
    await loginAs(page, 'admin');
    /* Plant a local "submitted" the server has no record of. The strip used to
       believe it outright. */
    await page.addInitScript(() => {
      const p2 = n => (n < 10 ? '0' : '') + n;
      const d = new Date();
      const today = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      localStorage.setItem('nyati-quality-' + today, JSON.stringify({ _m: { status: 'submitted' }, data: {} }));
    });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#smry-ops-strip')).toBeVisible();

    const cls = await page.getAttribute('#smry-ops-strip a[title^="Quality"]', 'class');
    expect(cls, 'a local-only entry must not be reported as submitted').not.toContain('smry-ops-submitted');
  });
});

test.describe('Last 12 Months view', () => {
  /* The Apr→Mar tracker cannot show a run of history that crosses the fiscal
     boundary: the Jan–Jun 2026 figures seeded from the M-11 workbooks sit in
     the last three columns of FY2025-26 and the first three of FY2026-27, so
     half of them are off-screen whichever year is selected. */

  test('the 12 columns are the months ending at the selected one', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/index.html?dept=production');
    await page.selectOption('#month-select', '6');
    await page.selectOption('#year-select', '2026');
    await page.selectOption('#view-select', 'rolling');
    await page.waitForLoadState('networkidle');

    const headers = await page.evaluate(() =>
      [...document.querySelectorAll('#dept-production .kpi-table .thead-row th')]
        .slice(6, 18).map(th => th.textContent.replace(/\s+/g, ' ').trim()));

    expect(headers).toHaveLength(12);
    expect(headers[0], 'window starts 11 months before June 2026').toContain('Jul');
    expect(headers[0], 'a new year must be labelled').toContain('2025');
    expect(headers[11], 'window ends at the selected month').toContain('Jun');
    /* Jan is where the window crosses into 2026 — it must say so. */
    expect(headers[6]).toContain('Jan');
    expect(headers[6]).toContain('2026');
  });

  /* Reads the twelve tracker cells of one KPI row. */
  async function trackerCells(page, label) {
    return page.evaluate(l => {
      const row = [...document.querySelectorAll('#dept-production .kpi-table .data-row')]
        .find(tr => tr.querySelector('td').textContent.trim() === l);
      return [...row.querySelectorAll('td')].slice(6, 18).map(td => td.textContent.trim());
    }, label);
  }

  async function openRolling(page) {
    await loginAs(page, 'admin');
    await page.goto('/index.html?dept=production');
    await page.selectOption('#month-select', '6');
    await page.selectOption('#year-select', '2026');
    await page.selectOption('#view-select', 'rolling');
    await page.waitForLoadState('networkidle');
  }

  test('Jan–Jun 2026 read as six consecutive, populated columns', async ({ page }) => {
    /* VRM Output is manual-only — no formula-registry key — so every column
       comes from kpi_monthly and the comparison is unambiguous. */
    const { rows } = await pool.query(
      `SELECT year, month, actual FROM kpi_monthly
       WHERE department='production' AND kpi_key='vrm-output'
         AND year=2026 AND month BETWEEN 1 AND 6 ORDER BY month`);
    test.skip(rows.length < 6, 'Jan–Jun 2026 vrm-output not seeded in this database');

    await openRolling(page);
    /* June 2026 is the last column, so Jan–Jun are columns 6..11 of the window. */
    const janToJun = (await trackerCells(page, 'VRM Output')).slice(6, 12);

    expect(janToJun.filter(v => v === '—'), 'no gaps in a seeded run').toEqual([]);
    for (let i = 0; i < 6; i++) {
      expect(Number(janToJun[i].replace(/,/g, '')), `month ${i + 1}`)
        .toBeCloseTo(Number(rows[i].actual), 0);
    }
  });

  test('a formula-owned KPI still shows the computed value for the selected month', async ({ page }) => {
    /* Kiln Output is BOTH stored in kpi_monthly and computed by the formula
       engine from daily_reports. The engine owns the selected month — that is
       the whole point of the auto-cell — while kpi_monthly fills the rest of
       the window. Asserted so the difference is never mistaken for a seeding
       error: the June column deliberately disagrees with kpi_monthly. */
    await openRolling(page);
    const cells = await trackerCells(page, 'Kiln Output');
    expect(cells.slice(6, 12).filter(v => v === '—'), 'no gaps in a seeded run').toEqual([]);

    const isAuto = await page.evaluate(() => {
      const row = [...document.querySelectorAll('#dept-production .kpi-table .data-row')]
        .find(tr => tr.querySelector('td').textContent.trim() === 'Kiln Output');
      return row.querySelectorAll('td')[17].classList.contains('auto-cell');
    });
    expect(isAuto, 'the last column is the selected month, owned by the formula engine').toBe(true);
  });

  test('the fiscal views still work as before', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/index.html?dept=production');
    await page.selectOption('#month-select', '6');
    await page.selectOption('#year-select', '2026');
    await page.selectOption('#view-select', 'full');
    await page.waitForLoadState('networkidle');

    const headers = await page.evaluate(() =>
      [...document.querySelectorAll('#dept-production .kpi-table .thead-row th')]
        .slice(6, 18).map(th => th.textContent.replace(/\s+/g, ' ').trim()));
    expect(headers[0], 'a fiscal year still starts at April').toContain('Apr');
    expect(headers[11], 'and ends at March').toContain('Mar');
  });
});
