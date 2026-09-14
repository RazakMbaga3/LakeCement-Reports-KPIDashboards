/*
  The daily form pages themselves.

  What a person sees on the form must match what the server recorded. The
  status vocabulary used to be draft/submitted on the client and
  draft/pending_approval/approved/rejected on the server, so a report waiting
  for a signature and one the HOD had turned back both showed the same green
  "Report Submitted & Locked".
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const D = '1999-06-16';

/* page → [formType, a role that may FILL it]. Two form types are shared,
   so they appear twice — each submitting role must get the real form, not
   the view-only shell (power-cons: pm + ei since 2026-09-11; dispatch:
   logistics + packing since 2026-09-14). */
const FORMS = [
  ['/daily-report.html',                 'production',       'production'],
  ['/power-plant-report.html',           'cpp',              'cpp'],
  ['/mines-report.html',                 'mines',            'mining'],
  ['/forms/stoppage-form.html',          'stoppage',         'pm'],
  ['/forms/power-form.html',             'power-cons',       'pm'],
  ['/forms/dispatch-form.html',          'dispatch',         'logistics'],
  ['/forms/dispatch-form.html',          'dispatch',         'packing'],
  ['/forms/materials-form.html',         'materials',        'stores'],
  ['/forms/quality-form.html',           'quality',          'production'],
  ['/forms/limestone-form.html',         'limestone',        'production'],
  ['/forms/pile-quality-form.html',      'pile-quality',     'production'],
  ['/forms/sales-projection-form.html',  'sales-projection', 'sales'],
];

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
}
async function seed(formType, status, reason) {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['e2e_production']);
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status, rejection_reason)
     VALUES ($1,$2,'day',$3,$4,NOW(),$5,$6)
     ON CONFLICT (form_type, record_date, shift) DO UPDATE
       SET data = EXCLUDED.data, status = EXCLUDED.status, rejection_reason = EXCLUDED.rejection_reason`,
    [formType, D, JSON.stringify({ kiln_prod_mt: 1750 }), rows[0].id, status, reason || null]
  );
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

for (const [url, formType, role] of FORMS) {
  test(`${url} loads clean for ${role}`, async ({ page }) => {
    const errors = collectErrors(page);
    await loginAs(page, role);
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#app-sidebar')).toBeVisible();
    /* The owning role must get the real controls, not the view-only shell. */
    await expect(page.locator('#dr-view-only-banner'),
      `${role} owns ${formType} and must be able to edit it`).toHaveCount(0);
    expect(errors(), `uncaught errors on ${url}`).toEqual([]);
  });
}

test('a role that does not own the form gets a view-only page', async ({ page }) => {
  await loginAs(page, 'stores');                 // owns 'materials' only
  await page.goto('/forms/quality-form.html');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#dr-view-only-banner')).toBeVisible();
  await expect(page.locator('.btn-sub').first()).toBeHidden();
  await expect(page.locator('.btn-save').first()).toBeHidden();
  /* …but the date picker must stay live, or a view-only user is stuck on
     whatever day the page happened to open with. */
  await expect(page.locator('input[data-field="date"]').first()).toBeEnabled();
});

test('every form defaults to the LOCAL date, not the UTC one', async ({ page }) => {
  /* EAT is UTC+3: between local midnight and 03:00, toISOString() returns
     yesterday, so a form opened at 01:00 saved to the wrong day. */
  await loginAs(page, 'production');
  await page.goto('/forms/quality-form.html');
  await page.waitForLoadState('networkidle');
  const shown = await page.inputValue('input[type="date"]');
  const expected = await page.evaluate(() => {
    const d = new Date(), p2 = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  });
  expect(shown).toBe(expected);
});

test.describe('the four states, as the author sees them', () => {
  const QUALITY = '/forms/quality-form.html';

  test('a report awaiting sign-off does not claim to be approved', async ({ page }) => {
    await seed('quality', 'pending_approval');
    await loginAs(page, 'production');
    await page.goto(QUALITY + '?d=' + D);
    await page.waitForLoadState('networkidle');
    await page.evaluate(d => {
      const el = document.querySelector('input[type="date"]');
      el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, D);
    await expect(page.locator('.rpt-pill')).toHaveText('AWAITING SIGN-OFF');
    await expect(page.locator('#_nyb')).toContainText('waiting for your HOD');
    /* Still locked — it has been sent, and the approver is looking at it. */
    await expect(page.locator('.btn-sub').first()).toBeDisabled();
  });

  test('a rejected report says why, and can be corrected and resent', async ({ page }) => {
    await seed('quality', 'rejected', 'Free lime reading looks transposed');
    await loginAs(page, 'production');
    await page.goto(QUALITY);
    await page.waitForLoadState('networkidle');
    await page.evaluate(d => {
      const el = document.querySelector('input[type="date"]');
      el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, D);

    await expect(page.locator('.rpt-pill')).toHaveText('REJECTED');
    const banner = page.locator('#_nyb');
    await expect(banner).toContainText('Rejected by your HOD');
    await expect(banner, 'the author must be told WHY').toContainText('transposed');
    /* …and it must be editable again — a rejected report that stays locked
       cannot be corrected, which is the whole point of rejecting it. */
    await expect(page.locator('.btn-sub').first()).toBeEnabled();
    await expect(page.locator('.btn-save').first()).toBeEnabled();
  });

  test('an approved report is locked and says so', async ({ page }) => {
    await seed('quality', 'approved');
    await loginAs(page, 'production');
    await page.goto(QUALITY);
    await page.waitForLoadState('networkidle');
    await page.evaluate(d => {
      const el = document.querySelector('input[type="date"]');
      el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, D);
    await expect(page.locator('.rpt-pill')).toHaveText('APPROVED');
    await expect(page.locator('.btn-sub').first()).toBeDisabled();
  });

  test('saving a draft leaves the form open for more work', async ({ page }) => {
    await loginAs(page, 'production');
    await page.goto(QUALITY);
    await page.waitForLoadState('networkidle');
    await page.evaluate(d => {
      const el = document.querySelector('input[type="date"]');
      el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, D);

    await page.locator('.btn-save').first().click();
    await expect(page.locator('.rpt-pill')).toHaveText('DRAFT');
    await expect(page.locator('.btn-sub').first(), 'a draft must not lock the form').toBeEnabled();

    const { rows } = await pool.query(
      "SELECT status FROM daily_reports WHERE form_type='quality' AND record_date=$1", [D]);
    expect(rows.length, 'the draft must reach the server').toBe(1);
    expect(rows[0].status, 'and be stored AS a draft').toBe('draft');
  });
});

test('the sidebar fill-status dots report the server, not this browser', async ({ page }) => {
  /* These dots have been dead since the sidebar migration — they targeted
     .nav-btn, the horizontal bar the sidebar replaced — and before that they
     read localStorage only, so an operator saw grey for reports a colleague
     had already submitted. */
  const p2 = n => (n < 10 ? '0' : '') + n;
  const now = new Date();
  const todayIso = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
  await pool.query("DELETE FROM daily_reports WHERE record_date = $1 AND form_type = 'quality'", [todayIso]);

  await loginAs(page, 'production');
  await page.goto('/forms/quality-form.html');
  await page.waitForLoadState('networkidle');

  const dot = page.locator('.sb-item[data-page="quality-form.html"] .nav-dot');
  await expect(dot, 'every Daily Reports row must carry a dot').toHaveCount(1);
  await expect(dot).toHaveClass(/nav-dot-empty/);

  /* Now let a DIFFERENT person submit today's quality report. */
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['e2e_production_officer']);
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status)
     VALUES ('quality', $1, 'day', $2, $3, NOW(), 'approved')
     ON CONFLICT (form_type, record_date, shift) DO UPDATE
       SET data = EXCLUDED.data, status = EXCLUDED.status`,
    [todayIso, JSON.stringify({ q_free_lime: 1.4 }), rows[0].id]
  );

  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.sb-item[data-page="quality-form.html"] .nav-dot'),
    "someone else's submission must turn the dot green on this machine too")
    .toHaveClass(/nav-dot-submitted/);

  await pool.query("DELETE FROM daily_reports WHERE record_date = $1 AND form_type = 'quality'", [todayIso]);
});

test('production MTD folds in the live, unsaved day without waiting for a save', async ({ page }) => {
  /* Mirrors power-plant-report.html's live-MTD test: report-rollup.js's
     `live: true` flag (initReportRollup({form:'production', live:true}))
     should update data-roll-mtd cells as the open day is typed, not just
     after Save/Submit. kiln_prod_mt is a plain additive quantity here (no
     ratio/weighted-average fields on this page per the survey), so a
     simple sum check is enough. */
  const MTD_SEED_DATE = '1999-06-01';
  await pool.query("DELETE FROM daily_reports WHERE form_type = 'production' AND record_date IN ($1, $2)", [D, MTD_SEED_DATE]);

  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['e2e_production']);
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status)
     VALUES ('production', $1, 'day', $2, $3, NOW(), 'approved')`,
    [MTD_SEED_DATE, JSON.stringify({ kiln_prod_mt: 500 }), rows[0].id]
  );

  await loginAs(page, 'production');
  await page.goto('/daily-report.html');
  await page.waitForLoadState('networkidle');
  await page.fill('input[type="date"]', D);
  await page.waitForTimeout(400);

  await expect(page.locator('[data-roll-mtd="kiln_prod_mt"]').first()).toHaveText('500');

  await page.fill('input[data-field="kiln_prod_mt"]', '300');
  await page.locator('input[data-field="kiln_prod_mt"]').blur();
  await page.waitForTimeout(300);

  const check = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'production' AND record_date = $1", [D]);
  expect(check.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-roll-mtd="kiln_prod_mt"]').first()).toHaveText('800');

  await pool.query("DELETE FROM daily_reports WHERE form_type = 'production' AND record_date IN ($1, $2)", [D, MTD_SEED_DATE]);
});
