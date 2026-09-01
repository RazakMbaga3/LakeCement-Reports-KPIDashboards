/*
  Daily Reports — the submission pipeline.

  The through-line: what a person sees on the form must match what the server
  actually recorded. Before this phase the client knew only draft/submitted
  while the server tracked draft/pending_approval/approved/rejected, so a
  report awaiting sign-off and one an HOD had REJECTED both rendered as
  "Submitted & Locked".

  Writes go to 1999 dates — far outside any real record_date, cleaned up in
  afterAll and by global-teardown.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const SANDBOX_FROM = '1999-01-01', SANDBOX_TO = '1999-12-31';
const D = '1999-06-15';

async function cleanup() {
  await pool.query('DELETE FROM daily_reports WHERE record_date BETWEEN $1 AND $2', [SANDBOX_FROM, SANDBOX_TO]);
}
async function storedRow(formType, date = D, shift = 'day') {
  const { rows } = await pool.query(
    'SELECT status, data, rejection_reason FROM daily_reports WHERE form_type=$1 AND record_date=$2 AND shift=$3',
    [formType, date, shift]
  );
  return rows[0] || null;
}
/* Posts exactly as forms/api-client.js does, from inside the page, so the
   token handling and CORS are exercised too. */
async function post(page, formType, body) {
  return page.evaluate(async ([ft, b]) => {
    const res = await fetch(`${_API_BASE}/reports/${ft}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() },
      body: JSON.stringify(b),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [formType, body]);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test.describe('submit pipeline', () => {
  test('a partial payload MERGES — it must not wipe fields it does not know', async ({ page }) => {
    /* The defect this guards: power-plant-report.html renders 22 CPP metrics
       but binds only `date` and `prepared_by` to inputs, while being wired to
       Submit. With a replacing upsert, one click replaced that day's entire
       CPP record with two fields. */
    await loginAs(page, 'cpp');
    await page.goto('/index.html');

    let r = await post(page, 'cpp', { date: D, shift: 'day',
      data: { cpp_gross_gen_kwh: 152000, cpp_aux_kwh: 17000, cpp_heat_rate_plant: 3900 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    // Now the partial write a display-only page would make.
    r = await post(page, 'cpp', { date: D, shift: 'day', data: { prepared_by: 'CPP Officer' } });
    expect(r.status).toBe(200);

    const row = await storedRow('cpp');
    expect(row.data.prepared_by).toBe('CPP Officer');
    expect(Number(row.data.cpp_gross_gen_kwh), 'the 3 metrics must survive').toBe(152000);
    expect(Number(row.data.cpp_aux_kwh)).toBe(17000);
    expect(Number(row.data.cpp_heat_rate_plant)).toBe(3900);
  });

  test('replace:true still overwrites, for callers that own the whole row', async ({ page }) => {
    await loginAs(page, 'cpp');
    await page.goto('/index.html');
    await post(page, 'cpp', { date: D, shift: 'day', data: { cpp_aux_kwh: 17000, cpp_run_hrs: 24 } });
    const r = await post(page, 'cpp', { date: D, shift: 'day', replace: true, data: { cpp_aux_kwh: 1 } });
    expect(r.status).toBe(200);
    const row = await storedRow('cpp');
    expect(Number(row.data.cpp_aux_kwh)).toBe(1);
    expect(row.data.cpp_run_hrs, 'replace must drop the other fields').toBeUndefined();
  });

  test('a draft is stored as a draft, whoever saves it', async ({ page }) => {
    /* An HOD "Save Draft" used to store status=approved — a half-filled form
       counted as a finished, signed-off report. */
    await loginAs(page, 'cpp');                     // seeded at level 'hod'
    await page.goto('/index.html');
    const r = await post(page, 'cpp', { date: D, shift: 'day', status: 'draft', data: { cpp_run_hrs: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.record.status).toBe('draft');
    expect((await storedRow('cpp')).status).toBe('draft');
  });

  test('an HOD submission self-certifies as approved', async ({ page }) => {
    await loginAs(page, 'cpp');
    await page.goto('/index.html');
    const r = await post(page, 'cpp', { date: D, shift: 'day', data: { cpp_run_hrs: 24 } });
    expect(r.body.record.status).toBe('approved');
  });

  test('a role may not submit another department form', async ({ page }) => {
    await loginAs(page, 'stores');                  // owns 'materials' only
    await page.goto('/index.html');
    const r = await post(page, 'cpp', { date: D, shift: 'day', data: { cpp_run_hrs: 1 } });
    expect(r.status).toBe(403);
    expect(await storedRow('cpp')).toBeNull();
  });

  test('the retired power-plant form type is refused', async ({ page }) => {
    await loginAs(page, 'cpp');
    await page.goto('/index.html');
    const r = await post(page, 'power-plant', { date: D, shift: 'day', data: { x: 1 } });
    expect(r.status, 'power-plant no longer exists — see backend/config/forms.js').toBeGreaterThanOrEqual(400);
  });

  test('a non-numeric value for a KPI field is rejected', async ({ page }) => {
    await loginAs(page, 'cpp');
    await page.goto('/index.html');
    const r = await post(page, 'cpp', { date: D, shift: 'day', data: { cpp_heat_rate_plant: 'about 3900' } });
    expect(r.status).toBe(400);
    expect(await storedRow('cpp')).toBeNull();
  });
});

test.describe('drafts and rejected reports are not data', () => {
  /* Reads what the completeness matrix counts as an entered report. */
  async function enteredForms(page, date) {
    return page.evaluate(async (d) => {
      const res = await fetch(`${_API_BASE}/mis/completeness?from=${d}&to=${d}`,
        { headers: { Authorization: 'Bearer ' + getAuthToken() } });
      const p = await res.json();
      const day = (p.days || []).find(x => x.date === d);
      return day ? day.forms.filter(f => f.present).map(f => f.formType) : [];
    }, date);
  }

  test('a draft does not count as an entered report', async ({ page }) => {
    await loginAs(page, 'production');
    await page.goto('/index.html');
    await post(page, 'production', { date: D, shift: 'day', status: 'draft', data: { kiln_prod_mt: 1800 } });
    expect((await storedRow('production')).status).toBe('draft');
    expect(await enteredForms(page, D), 'a draft is work in progress, not a report').toEqual([]);
  });

  test('a rejected report stops counting, and carries its reason', async ({ page }) => {
    await loginAs(page, 'production_officer');       // level 'officer'
    await page.goto('/index.html');
    const sub = await post(page, 'production', { date: D, shift: 'day', data: { kiln_prod_mt: 1800 } });
    expect(sub.body.record.status, 'an officer needs sign-off').toBe('pending_approval');
    expect(await enteredForms(page, D), 'pending IS reported data').toEqual(['production']);

    await loginAs(page, 'production');               // the HOD rejects it
    await page.goto('/index.html');
    const rej = await page.evaluate(async (d) => {
      const res = await fetch(`${_API_BASE}/reports/production/${d}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() },
        body: JSON.stringify({ shift: 'day', reason: 'Kiln output does not match the log sheet' }),
      });
      return res.status;
    }, D);
    expect(rej).toBe(200);

    const row = await storedRow('production');
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toContain('log sheet');
    expect(await enteredForms(page, D), 'data the HOD rejected must stop counting').toEqual([]);
  });
});

test.describe('approvals screen', () => {
  test('an HOD sees the pending report, its real name and its figures', async ({ page }) => {
    await loginAs(page, 'production_officer');
    await page.goto('/index.html');
    await post(page, 'production', { date: D, shift: 'day', data: { kiln_prod_mt: 1800, cm1_425r_mt: 900 } });

    const errors = collectErrors(page);
    await loginAs(page, 'production');
    await page.goto('/approvals.html');
    await page.waitForLoadState('networkidle');

    const row = page.locator(`#apv-table tbody tr[data-date="${D}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.locator('.apv-form-label'), 'the real report name, not a title-cased slug')
      .toHaveText('Production Summary');

    // The figures must be visible to the person signing them off.
    await row.locator('button[data-action="view"]').click();
    const detail = page.locator('.apv-detail:not([hidden])');
    await expect(detail).toHaveCount(1);
    await expect(detail).toContainText('Kiln Prod Mt');
    await expect(detail).toContainText('1800');
    expect(errors()).toEqual([]);
  });

  test('approving clears it from the queue and marks it approved', async ({ page }) => {
    await loginAs(page, 'production_officer');
    await page.goto('/index.html');
    await post(page, 'production', { date: D, shift: 'day', data: { kiln_prod_mt: 1800 } });

    await loginAs(page, 'production');
    await page.goto('/approvals.html');
    await page.waitForLoadState('networkidle');
    await page.locator(`#apv-table tbody tr[data-date="${D}"] button[data-action="approve"]`).click();
    await expect(page.locator(`#apv-table tbody tr[data-date="${D}"]`)).toHaveCount(0);
    expect((await storedRow('production')).status).toBe('approved');
  });

  test('an officer sees an empty queue, and cannot approve their own report', async ({ page }) => {
    await loginAs(page, 'production_officer');
    await page.goto('/index.html');
    await post(page, 'production', { date: D, shift: 'day', data: { kiln_prod_mt: 1800 } });

    await page.goto('/approvals.html');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#apv-table tbody .apv-empty')).toHaveCount(1);

    const status = await page.evaluate(async (d) => {
      const res = await fetch(`${_API_BASE}/reports/production/${d}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() },
        body: JSON.stringify({ shift: 'day' }),
      });
      return res.status;
    }, D);
    expect(status, 'an officer must not approve their own submission').toBe(403);
    expect((await storedRow('production')).status).toBe('pending_approval');
  });
});
