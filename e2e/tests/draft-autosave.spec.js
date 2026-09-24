/*
  Drafts: nothing typed is lost, and a draft can always be found again.

  Follows draft-reaccess.spec.js (the buttons and the Load Previous list).
  What is held here:

    1. Inputs that carry no data-field used to be saved only as a POSITION in
       a localStorage array — never sent to the server, and skipped on reload
       as soon as a server record existed. The pile log, the dispatch log rows
       and the sign-off names silently disappeared. They are now named
       structurally and travel like any other field, including pile-log rows
       added with "Add Row".
    2. Work is autosaved to the server a few seconds after typing stops — as a
       draft, without an audit row, and never over a report that has been
       submitted or approved.
    3. Switching to another day keeps what was typed as a draft first.
    4. Merely opening a page (cells filled by script) never creates a draft.
    5. A draft on the server is announced: a banner on the form, and a dot in
       the sidebar, so it is found without going looking for it.
    6. Work that never reached the server is put back and sent on the next
       visit, and the toolbar says where it is at every moment.

  Writes go to 1999 dates (swept by cleanup and global-teardown) except the
  banner test, which needs a RECENT date; that row is authored by an e2e
  account, which global-teardown also removes.
*/
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');
const { setReportDate } = require('../fixtures/forms');
const { pool } = require('../fixtures/db');

const D  = '1999-06-19';
const D2 = '1999-06-20';

const pad = n => (n < 10 ? '0' : '') + n;
const isoDaysAgo = n => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const YESTERDAY = isoDaysAgo(1);

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  await pool.query(
    `DELETE FROM daily_reports WHERE record_date = $1 AND submitted_by IN (SELECT id FROM users WHERE username LIKE 'e2e\\_%')`,
    [YESTERDAY]);
}
const row = async (form, date = D) =>
  (await pool.query('SELECT status, data, rejection_reason FROM daily_reports WHERE form_type=$1 AND record_date=$2 AND shift=\'day\'', [form, date])).rows[0] || null;
const auditCount = async (form, date, action) =>
  +(await pool.query('SELECT count(*) n FROM audit_log WHERE form_type=$1 AND record_date=$2 AND action=$3', [form, date, action])).rows[0].n;

/* Autosave waits 20 s in production; the page reads this override. */
const fastAutosave = ctxOrPage => ctxOrPage.addInitScript(() => { window.NYATI_AUTOSAVE_MS = 700; });

async function open(page, role, path, date = D) {
  await loginAs(page, role);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await setReportDate(page, date);
  await page.waitForTimeout(500);
}
const chip = page => page.locator('#_ny-saved-chip');

test.beforeEach(cleanup);
test.afterAll(cleanup);

test.describe('inputs without a data-field', () => {
  test('pile log cells — including rows added with Add Row — survive a save and another device', async ({ page, browser }) => {
    await open(page, 'production_officer', '/forms/pile-quality-form.html');
    const log = page.locator('#pile-log-tbl');

    // Two rows beyond the 18 the page ships with (rowCount starts at 18).
    await page.getByRole('button', { name: /Add Row/ }).click();
    await page.getByRole('button', { name: /Add Row/ }).click();
    const rows = log.locator('tbody tr').filter({ has: page.locator('input') });
    await expect(rows).toHaveCount(20);

    await rows.nth(0).locator('input').nth(0).fill('08:15');
    await rows.nth(0).locator('input').nth(1).fill('44.5');
    await rows.nth(19).locator('input').nth(0).fill('23:40');
    await rows.nth(19).locator('input').nth(1).fill('46.1');

    await page.locator('.btn-save').first().click();
    await expect.poll(async () => (await row('pile-quality'))?.status, { timeout: 8000 }).toBe('draft');

    const stored = (await row('pile-quality')).data;
    const auto = Object.entries(stored).filter(([k]) => k.startsWith('_a_pile-log-tbl_'));
    expect(auto.length, 'pile log cells must reach the server').toBeGreaterThan(100);
    expect(auto.map(([, v]) => v)).toEqual(expect.arrayContaining(['08:15', '23:40', '46.1']));
    // Row 1's CaO cell already had a data-field (cao_h1) and keeps going by that name.
    expect(stored.cao_h1).toBe('44.5');

    const other = await browser.newContext();
    try {
      const b = await other.newPage();
      await open(b, 'production_officer', '/forms/pile-quality-form.html');
      const bRows = b.locator('#pile-log-tbl tbody tr').filter({ has: b.locator('input') });
      await expect(bRows, 'the 20-row log must come back as 20 rows').toHaveCount(20);
      await expect(bRows.nth(0).locator('input').nth(0)).toHaveValue('08:15');
      await expect(bRows.nth(0).locator('input').nth(1)).toHaveValue('44.5');
      await expect(bRows.nth(19).locator('input').nth(0)).toHaveValue('23:40');
      await expect(bRows.nth(19).locator('input').nth(1)).toHaveValue('46.1');
    } finally { await other.close(); }
  });

  test('a draft typed on a phone (card view) comes back in the desktop grid, and the other way round', async ({ page, browser }) => {
    /* mobile-entry.js MOVES table inputs into cards below 960px. The names are
       given before that happens, so the same cell has the same name in both
       views — otherwise a draft would only ever open on the kind of screen it
       was typed on. */
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'production_officer', '/forms/pile-quality-form.html');
    expect(await page.evaluate(() => document.body.classList.contains('me-view-cards')),
      'the phone must actually be showing cards for this test to mean anything').toBe(true);

    const key = '_a_pile-log-tbl_r2_c1';                       // first pile-log time cell
    await page.evaluate(k => {
      const el = document.querySelector(`[data-field="${k}"]`);
      el.value = '07:05';
    }, key);
    await page.evaluate(() => document.querySelector('.btn-save').click());
    await expect.poll(async () => (await row('pile-quality'))?.data?.[key], { timeout: 8000 }).toBe('07:05');

    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const d = await desk.newPage();
      await open(d, 'production_officer', '/forms/pile-quality-form.html');
      await expect(d.locator(`[data-field="${key}"]`)).toHaveValue('07:05');

      // and back: typed on the desktop, opened on the phone
      await d.locator(`[data-field="${key}"]`).fill('19:30');
      await d.locator('.btn-save').first().click();
      await expect.poll(async () => (await row('pile-quality'))?.data?.[key], { timeout: 8000 }).toBe('19:30');
    } finally { await desk.close(); }

    await page.reload();
    await page.waitForLoadState('networkidle');
    await setReportDate(page, D);
    await expect(page.locator(`[data-field="${key}"]`)).toHaveValue('19:30');
  });

  test('dispatch log rows and sign-off names come back on another device', async ({ page, browser }) => {
    await open(page, 'logistics_officer', '/forms/dispatch-form.html');
    const time = page.locator('input[data-field-auto="1"][type="time"]').first();
    const name = page.locator('input.so-in[data-field-auto="1"]').first();
    const timeKey = await time.getAttribute('data-field');
    const nameKey = await name.getAttribute('data-field');
    expect(timeKey).toMatch(/^_a_/);
    expect(nameKey).toMatch(/^_a_/);

    await time.fill('09:45');
    await name.fill('A. Mwakyusa');
    await page.locator('.btn-save').first().click();
    await expect.poll(async () => (await row('dispatch'))?.status, { timeout: 8000 }).toBe('draft');
    const stored = (await row('dispatch')).data;
    expect(stored[timeKey]).toBe('09:45');
    expect(stored[nameKey]).toBe('A. Mwakyusa');

    const other = await browser.newContext();
    try {
      const b = await other.newPage();
      await open(b, 'logistics_officer', '/forms/dispatch-form.html');
      await expect(b.locator(`input[data-field="${timeKey}"]`)).toHaveValue('09:45');
      await expect(b.locator(`input[data-field="${nameKey}"]`)).toHaveValue('A. Mwakyusa');
    } finally { await other.close(); }
  });

  test('controls that are not report data are not saved', async ({ page }) => {
    await open(page, 'production_officer', '/forms/quality-form.html');
    await page.evaluate(() => {
      // the export panel's e-mail box (a UI control, no data-field of its own)
      const el = document.querySelector('.exp-email-in');
      if (el) el.value = 'someone@example.com';
    });
    await page.locator('.btn-save').first().click();
    await page.waitForTimeout(1500);
    const r = await row('quality');
    const values = r ? Object.values(r.data) : [];
    expect(values, 'an e-mail address typed into the export box is not report data').not.toContain('someone@example.com');
  });
});

test.describe('autosave', () => {
  test('a draft reaches the server a few seconds after typing stops — with no audit row', async ({ page }) => {
    await fastAutosave(page);
    await open(page, 'cpp_officer', '/power-plant-report.html');

    await page.fill('input[data-field="cpp_gross_gen_kwh"]', '238500');
    await expect(chip(page)).toContainText('Unsaved');

    await expect.poll(async () => (await row('cpp'))?.status, { timeout: 8000 }).toBe('draft');
    expect(+(await row('cpp')).data.cpp_gross_gen_kwh).toBe(238500);
    await expect(chip(page)).toContainText('Saved');
    expect(await auditCount('cpp', D, 'FORM_DRAFT'), 'a background save leaves no audit row').toBe(0);

    // A deliberate Save Draft still does.
    await page.locator('.btn-save').first().click();
    await expect.poll(() => auditCount('cpp', D, 'FORM_DRAFT'), { timeout: 5000 }).toBe(1);
  });

  test('opening a page — cells filled by script — never creates a draft', async ({ page }) => {
    await fastAutosave(page);
    await open(page, 'cpp_officer', '/power-plant-report.html');
    // A script sets and announces a value, as report-loader / kpi-live do.
    await page.evaluate(() => {
      const el = document.querySelector('input[data-field="cpp_gross_gen_kwh"]');
      el.value = '5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(2500);
    expect(await row('cpp'), 'a script-made edit is not the user saving anything').toBeNull();
    await expect(chip(page)).not.toContainText('Unsaved');
  });

  test('switching to another day keeps what was typed as a draft first', async ({ page }) => {
    await open(page, 'cpp_officer', '/power-plant-report.html');           // no fast autosave: the hand-off must do it
    await page.fill('input[data-field="cpp_gross_gen_kwh"]', '111000');
    await setReportDate(page, D2);                              // leave D with unsaved work

    await expect.poll(async () => (await row('cpp', D))?.status, { timeout: 8000 }).toBe('draft');
    expect(+(await row('cpp', D)).data.cpp_gross_gen_kwh).toBe(111000);
    await expect(page.locator('input[data-field="cpp_gross_gen_kwh"]'), 'the new day starts clean').toHaveValue('');

    await setReportDate(page, D);                               // and coming back finds it
    await expect(page.locator('input[data-field="cpp_gross_gen_kwh"]')).toHaveValue('111000');
  });

  test('offline: the chip says so, it keeps retrying, and it lands when the server is back', async ({ page }) => {
    await fastAutosave(page);
    await open(page, 'cpp_officer', '/power-plant-report.html');

    let blocked = true;
    await page.route('**/api/reports/cpp', r => (blocked && r.request().method() === 'POST' ? r.abort() : r.continue()));

    await page.fill('input[data-field="cpp_gross_gen_kwh"]', '222000');
    await expect(chip(page)).toContainText('this device only', { timeout: 8000 });
    expect(await row('cpp')).toBeNull();

    blocked = false;
    await expect.poll(async () => (await row('cpp'))?.status, { timeout: 15000 }).toBe('draft');
    expect(+(await row('cpp')).data.cpp_gross_gen_kwh).toBe(222000);
    await expect(chip(page)).toContainText('Saved');
  });

  test('typed work that never reached the server is put back on the next visit and sent', async ({ page }) => {
    await fastAutosave(page);
    await open(page, 'cpp_officer', '/power-plant-report.html');
    await page.fill('input[data-field="cpp_gross_gen_kwh"]', '100');
    await page.locator('.btn-save').first().click();
    await expect.poll(async () => (await row('cpp'))?.status, { timeout: 8000 }).toBe('draft');

    // Later, offline, more is typed: a snapshot this device holds but the server never confirmed.
    await page.evaluate(([d]) => {
      const k = 'nyati-cpp-' + d;
      const snap = JSON.parse(localStorage.getItem(k));
      snap._m.unsynced = true;
      snap._m.savedAt = new Date(Date.now() + 60000).toISOString();
      snap.data.cpp_gross_gen_kwh = '999';
      localStorage.setItem(k, JSON.stringify(snap));
    }, [D]);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await setReportDate(page, D);
    await expect(page.locator('input[data-field="cpp_gross_gen_kwh"]'),
      'the newer typed value must win over the older server copy').toHaveValue('999');
    await expect.poll(async () => +(await row('cpp')).data.cpp_gross_gen_kwh, { timeout: 10000 }).toBe(999);
  });
});

test.describe('the server side of autosave', () => {
  const post = (page, form, date, data, opts) => page.evaluate(async ([f, d, dt, o]) => {
    try { const r = await NyatiAPI.submitForm(f, d, 'day', dt, o); return { ok: true, status: r.record.status }; }
    catch (e) { return { ok: false, http: e.status }; }
  }, [form, date, data, opts]);

  test('it refuses a submitted report and leaves it exactly as it was', async ({ page }) => {
    await loginAs(page, 'cpp_officer');
    await page.goto('/power-plant-report.html');
    await page.waitForLoadState('networkidle');

    expect((await post(page, 'cpp', D, { cpp_gross_gen_kwh: '5000' }, { status: 'submitted' })).status).toBe('pending_approval');
    const r = await post(page, 'cpp', D, { cpp_gross_gen_kwh: '1' }, { status: 'draft', autosave: true });
    expect(r).toEqual({ ok: false, http: 409 });
    const after = await row('cpp');
    expect(after.status).toBe('pending_approval');
    expect(+after.data.cpp_gross_gen_kwh, 'a stale tab must not overwrite a signed-off figure').toBe(5000);
  });

  test('it keeps a REJECTED report rejected, with the HOD\'s reason', async ({ page }) => {
    await loginAs(page, 'cpp_officer');
    await page.goto('/power-plant-report.html');
    await page.waitForLoadState('networkidle');
    await post(page, 'cpp', D, { cpp_gross_gen_kwh: '5000', cpp_aux_kwh: '400' }, { status: 'submitted' });
    await pool.query(
      "UPDATE daily_reports SET status='rejected', rejection_reason='aux looks wrong' WHERE form_type='cpp' AND record_date=$1", [D]);

    const r = await post(page, 'cpp', D, { cpp_aux_kwh: '450' }, { status: 'draft', autosave: true });
    expect(r).toEqual({ ok: true, status: 'rejected' });
    const after = await row('cpp');
    expect(after.status).toBe('rejected');
    expect(after.rejection_reason).toBe('aux looks wrong');
    expect(+after.data.cpp_aux_kwh, 'the correction is saved').toBe(450);
    expect(+after.data.cpp_gross_gen_kwh, 'and nothing else is lost (merged)').toBe(5000);
  });

  test('it needs the same form access as a save, and cannot be a submission', async ({ page }) => {
    await loginAs(page, 'pm_officer');                     // P&M does not own the CPP form
    await page.goto('/forms/stoppage-form.html');
    await page.waitForLoadState('networkidle');
    expect(await post(page, 'cpp', D, { cpp_gross_gen_kwh: '1' }, { status: 'draft', autosave: true }))
      .toEqual({ ok: false, http: 403 });

    await loginAs(page, 'cpp_officer');
    await page.goto('/power-plant-report.html');
    await page.waitForLoadState('networkidle');
    const res = await page.evaluate(async () => {
      const r = await fetch(_API_BASE + '/reports/cpp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() },
        body: JSON.stringify({ date: '1999-06-19', shift: 'day', data: { cpp_gross_gen_kwh: '1' }, status: 'submitted', autosave: true }),
      });
      return r.status;
    });
    expect(res, 'an autosave that says it is a submission is a malformed request').toBe(400);
  });

  test('GET /reports/unfinished lists only my own forms, drafts and rejections', async ({ page }) => {
    await loginAs(page, 'cpp_officer');
    await page.goto('/power-plant-report.html');
    await page.waitForLoadState('networkidle');
    await post(page, 'cpp', YESTERDAY, { cpp_gross_gen_kwh: '1' }, { status: 'draft' });

    const rows = await page.evaluate(() => NyatiAPI.getUnfinished(14));
    expect(rows.every(r => r.form_type === 'cpp'), 'only forms this role may submit').toBe(true);
    expect(rows.map(r => [r.record_date, r.status])).toContainEqual([YESTERDAY, 'draft']);
    expect(rows.every(r => !('data' in r)), 'never the field data').toBe(true);

    // a role that submits nothing has nothing to finish
    await loginAs(page, 'management');
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => NyatiAPI.getUnfinished(14))).toEqual([]);
  });
});

test.describe('finding an unfinished report', () => {
  test('a banner on the form and a dot in the sidebar point at yesterday\'s draft — from another device', async ({ page, browser }) => {
    await loginAs(page, 'cpp_officer');
    await page.goto('/power-plant-report.html');
    await page.waitForLoadState('networkidle');
    await page.evaluate(async d => {
      await NyatiAPI.submitForm('cpp', d, 'day', { cpp_gross_gen_kwh: '4321' }, { status: 'draft' });
    }, YESTERDAY);

    const other = await browser.newContext();               // a different PC: nothing local at all
    try {
      const b = await other.newPage();
      await loginAs(b, 'cpp_officer');
      await b.goto('/power-plant-report.html');
      await b.waitForLoadState('networkidle');

      const banner = b.locator('#_ny-unfin');
      await expect(banner).toContainText('unfinished report');
      await expect(banner).toContainText('draft');

      const dot = b.locator('.sb-item[data-page="power-plant-report.html"] .nav-dot-draft');
      await expect(dot).toHaveCount(1);
      await expect(dot).toHaveAttribute('title', /Unfinished draft/);

      await banner.getByRole('button', { name: /Open/ }).first().click();
      await expect(b.locator('input[type="date"]')).toHaveValue(YESTERDAY);
      await expect(b.locator('input[data-field="cpp_gross_gen_kwh"]')).toHaveValue('4321');
      await expect(b.locator('#_ny-unfin'), 'the day you are on is not "another" unfinished day').toHaveCount(0);
    } finally { await other.close(); }
  });

  test('a report an HOD rejected is flagged red and says it needs correcting', async ({ page }) => {
    await loginAs(page, 'cpp_officer');
    await page.goto('/power-plant-report.html');
    await page.waitForLoadState('networkidle');
    await page.evaluate(async d => {
      await NyatiAPI.submitForm('cpp', d, 'day', { cpp_gross_gen_kwh: '4321' }, { status: 'submitted' });
    }, YESTERDAY);
    await pool.query(
      "UPDATE daily_reports SET status='rejected', rejection_reason='check gross' WHERE form_type='cpp' AND record_date=$1", [YESTERDAY]);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#_ny-unfin')).toContainText('rejected');
    await expect(page.locator('#_ny-unfin')).toHaveClass(/is-rejected/);
    await expect(page.locator('.sb-item[data-page="power-plant-report.html"] .nav-dot-rejected')).toHaveCount(1);
  });
});
