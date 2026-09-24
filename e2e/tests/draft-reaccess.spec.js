/*
  Getting a saved draft back.

  The report that started this: a CPP officer saved a draft of the 19
  September report and could not find it again. Three separate things stood
  between the draft and its author, and each is held here:

    1. The Save Draft button in the sign-off card at the foot of the form
       (seven pages ship one) was styled `btn-out`, and form-persist.js bound
       the history panel to `.btn-out` — so it opened a "Saved Snapshots"
       panel reading "No drafts saved yet" and saved nothing at all.
    2. "Load Previous" listed only THIS BROWSER's localStorage. A draft that
       was on the server — saved from another PC, a phone, a browser with
       cleared site data — was invisible to the person who wrote it.
    3. The same `.btn-out` binding swallowed every other outline button on
       those pages: the "View report" links never navigated.

  Writes go to 2098 dates, cleaned up here and by global-teardown.

  WHY 2098 AND NOT 1999, like every other spec: the Load Previous panel asks
  the server for the NEWEST 120 days (form-persist.js _HISTORY_LIMIT) and, by
  design, only claims a local draft is "this device only" for a day that list
  actually covers. Once the CPP history passed 120 days — the Apr-Sep 2026
  seed migrations alone are ~170 — a 1999 sandbox date sat beyond the end of
  the list, so the draft that WAS on the server was never listed and the
  device-only flag was (correctly) withheld. Two tests here started failing,
  and read as pre-existing defects, when the app was right and the tests had
  quietly assumed a near-empty database. They would have failed identically in
  CI, whose migrations seed the same days.

  A far-FUTURE date sorts first in a newest-first list, so it is inside the
  window however many real rows exist. The rule itself is now held directly
  by the two tests at the bottom, against a stubbed list, so it no longer
  depends on the size of the database at all.
*/
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');
const { setReportDate } = require('../fixtures/forms');
const { pool } = require('../fixtures/db');

const D  = '2098-06-19';
const D2 = '2098-06-20';
const D3 = '2098-06-21';

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '2098-01-01' AND '2098-12-31'");
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
}
async function storedRow(date = D) {
  const { rows } = await pool.query(
    "SELECT status, data FROM daily_reports WHERE form_type = 'cpp' AND record_date = $1 AND shift = 'day'", [date]);
  return rows[0] || null;
}

async function openForm(page, date = D) {
  await loginAs(page, 'cpp_officer');
  await page.goto('/power-plant-report.html');
  await page.waitForLoadState('networkidle');
  await setReportDate(page, date);
  await page.waitForTimeout(400);   // form-persist reloads the day on change
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test('the Save Draft at the foot of the form saves to the server, not a history panel', async ({ page }) => {
  await openForm(page);
  await page.fill('input[data-field="cpp_gross_gen_kwh"]', '238500');
  await page.fill('input[data-field="cpp_coal_cons"]', '118.4');

  /* Two buttons carry this label — the toolbar's and the sign-off card's.
     The card is the last thing on the page, which is where an officer who has
     just filled a long form naturally reaches for it. */
  const buttons = page.locator('button.btn-save', { hasText: 'Save Draft' });
  await expect(buttons).toHaveCount(2);
  await buttons.last().click();

  await expect.poll(async () => (await storedRow())?.status, { timeout: 8000 }).toBe('draft');
  const row = await storedRow();
  expect(+row.data.cpp_gross_gen_kwh).toBe(238500);
  expect(+row.data.cpp_coal_cons).toBe(118.4);
  await expect(page.locator('#_nyh'), 'Save Draft must not open the history panel').toHaveCount(0);
});

test('a draft saved on one device is listed — and opens — on another', async ({ page, browser }) => {
  await openForm(page);
  await page.fill('input[data-field="cpp_gross_gen_kwh"]', '238500');
  await page.locator('button.btn-save', { hasText: 'Save Draft' }).first().click();
  await expect.poll(async () => (await storedRow())?.status, { timeout: 8000 }).toBe('draft');

  /* A fresh browser context has its own empty localStorage: another PC, a
     phone, cleared site data, or the app opened at its other address. */
  const other = await browser.newContext();
  try {
    const b = await other.newPage();
    await loginAs(b, 'cpp_officer');
    await b.goto('/power-plant-report.html');
    await b.waitForLoadState('networkidle');
    expect(await b.evaluate(k => localStorage.getItem(k), 'nyati-cpp-' + D),
      'the second device must know nothing about the draft locally').toBeNull();

    await b.locator('[data-persist="history"]').click();
    const panel = b.locator('#_nyh');
    await expect(panel).toContainText(D);
    await expect(panel).toContainText('DRAFT');
    await expect(panel, 'a draft that IS on the server is not "this device only"').not.toContainText('This device only');

    await panel.getByText(D, { exact: true }).click();
    await expect(b.locator('input[type="date"]')).toHaveValue(D);
    await expect(b.locator('input[data-field="cpp_gross_gen_kwh"]')).toHaveValue('238500');
    await expect(b.locator('.rpt-pill')).toHaveText('DRAFT');
  } finally {
    await other.close();
  }
});

test('a draft only this browser holds is flagged, and blank autosaves are not listed', async ({ page }) => {
  await openForm(page);

  /* What an unsynced draft and a merely-browsed-to day each leave behind in
     localStorage (form-persist.js's own snapshot shape). Neither is on the
     server. */
  await page.evaluate(([d2, d3]) => {
    const snap = (date, data) => JSON.stringify({
      _m: { formId: 'cpp', date, savedAt: new Date().toISOString(), status: 'draft' },
      inputs: [], data: Object.assign({ date }, data),
    });
    localStorage.setItem('nyati-cpp-' + d2, snap(d2, { cpp_gross_gen_kwh: '1000' }));
    localStorage.setItem('nyati-cpp-' + d3, snap(d3, {}));
  }, [D2, D3]);

  await page.locator('[data-persist="history"]').click();
  const panel = page.locator('#_nyh');
  await expect(panel).toContainText(D2);
  await expect(panel, 'a draft the server never received must say so').toContainText('This device only');
  await expect(panel, 'a blank autosave restores nothing and only buries real drafts').not.toContainText(D3);
});

test('a "View report" link navigates instead of opening the history panel', async ({ page }) => {
  /* The link is an <a class="btn btn-out">, so the old `.btn-out` binding
     preventDefault()ed it and opened Load Previous. */
  await loginAs(page, 'logistics');
  await page.goto('/forms/dispatch-form.html');
  await page.waitForLoadState('networkidle');

  await page.locator('a.btn-out', { hasText: 'View report' }).click();
  await page.waitForURL('**/dispatch.html');
  await expect(page.locator('#_nyh')).toHaveCount(0);
});

test.describe('GET /api/reports/:formType/history', () => {
  test('lists days newest first with their status — dates only, never the field data', async ({ page }) => {
    await loginAs(page, 'cpp_officer');
    await page.goto('/power-plant-report.html');
    await page.waitForLoadState('networkidle');

    const out = await page.evaluate(async () => {
      await NyatiAPI.submitForm('cpp', '2098-06-18', 'day', { cpp_gross_gen_kwh: '1' }, { status: 'draft' });
      await NyatiAPI.submitForm('cpp', '2098-06-19', 'day', { cpp_gross_gen_kwh: '2' }, { status: 'submitted' });
      return {
        all: await NyatiAPI.getFormHistory('cpp', 365),
        one: await NyatiAPI.getFormHistory('cpp', 1),
      };
    });

    const mine = out.all.filter(r => r.record_date.startsWith('2098-'));
    expect(mine.map(r => [r.record_date, r.status])).toEqual([
      ['2098-06-19', 'pending_approval'],   // an officer's submission needs sign-off
      ['2098-06-18', 'draft'],
    ]);
    expect(out.all.every(r => !('data' in r)), 'history must not ship the field data').toBe(true);

    const dates = out.all.map(r => r.record_date);
    expect(dates, 'newest first').toEqual([...dates].sort().reverse());
    expect(out.one, 'limit is honoured').toHaveLength(1);
  });

  test('needs a login, and rejects a form type it does not know', async ({ page }) => {
    await loginAs(page, 'cpp_officer');
    await page.goto('/power-plant-report.html');
    await page.waitForLoadState('networkidle');

    const r = await page.evaluate(async () => {
      const get = (path, auth) => fetch(_API_BASE + path, {
        headers: auth ? { Authorization: 'Bearer ' + getAuthToken() } : {},
      }).then(res => res.status);
      return {
        anon:     await get('/reports/cpp/history', false),
        unknown:  await get('/reports/not-a-form/history', true),
        badLimit: await get('/reports/cpp/history?limit=0', true),
        ok:       await get('/reports/cpp/history', true),
      };
    });
    expect(r).toEqual({ anon: 401, unknown: 400, badLimit: 400, ok: 200 });
  });
});

test.describe('"this device only" is only claimed for days the server list covers', () => {
  /* form-persist.js _historyEntries(): a local draft is flagged "This device
     only — not on the server" when the server's answer proves it is not there.
     A FULL list (120 rows, the cap) proves nothing about days older than its
     last row, so for those the flag is withheld rather than guessed.

     Held here against a stubbed /history response, so the rule is tested
     directly and cannot be perturbed by how many real days the database has —
     which is what silently broke the two end-to-end tests above. */
  const OLD = '1999-06-01';   // older than every stubbed row

  function fakeHistory(n) {
    const rows = [];
    const start = Date.UTC(2097, 0, 1);
    for (let i = 0; i < n; i++) {
      const d = new Date(start + (n - 1 - i) * 86400000).toISOString().slice(0, 10);
      rows.push({ record_date: d, shift: 'day', status: 'approved', submitted_at: d + 'T08:00:00Z',
                  updated_at: d + 'T08:00:00Z', rejection_reason: null, saved_by_name: 'Stubbed' });
    }
    return rows;   // newest first, like the endpoint
  }

  async function panelFor(page, historyRows) {
    await openForm(page);
    await page.route('**/api/reports/cpp/history*', route => route.fulfill({ json: historyRows }));
    await page.evaluate(date => {
      localStorage.setItem('nyati-cpp-' + date, JSON.stringify({
        _m: { formId: 'cpp', date, savedAt: new Date().toISOString(), status: 'draft' },
        inputs: [], data: { date, cpp_gross_gen_kwh: '1000' },
      }));
    }, OLD);
    await page.locator('[data-persist="history"]').click();
    const panel = page.locator('#_nyh');
    await expect(panel).toContainText(OLD);
    return panel;
  }

  test('a short list covers everything, so an unsent local draft IS flagged', async ({ page }) => {
    const panel = await panelFor(page, fakeHistory(3));
    await expect(panel, 'the server said it has nothing this old — the draft is on this device only')
      .toContainText('This device only');
  });

  test('a full list says nothing about older days, so the flag is withheld', async ({ page }) => {
    const panel = await panelFor(page, fakeHistory(120));
    await expect(panel, 'the list is capped: a day older than its last row may well be on the server')
      .not.toContainText('This device only');
  });
});
