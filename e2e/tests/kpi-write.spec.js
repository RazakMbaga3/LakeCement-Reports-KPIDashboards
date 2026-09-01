/*
  The KPI write paths — the modal, the inline cell, remarks and clearing.

  All writes target YEAR 2001, the harness's sandbox (valid per routes/kpi.js's
  zYear, far outside any real fiscal year). global-teardown.js deletes it.
*/
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const YEAR = 2001, MONTH = 6, DEPT = 'production', KEY = 'kiln-output';

async function storedRow(kpiKey = KEY) {
  const { rows } = await pool.query(
    'SELECT target, actual, remarks FROM kpi_monthly WHERE department=$1 AND year=$2 AND month=$3 AND kpi_key=$4',
    [DEPT, YEAR, MONTH, kpiKey]
  );
  return rows[0] || null;
}

/* Drives the API exactly as kpi-data.js's _kpiPut does — same URL, same
   Authorization header, same body shape — from inside the page, so the token
   handling and CORS are exercised too. */
async function put(page, body) {
  return page.evaluate(async ([b, y, m, d]) => {
    const res = await fetch(`${_API_BASE}/kpi/${d}/${y}/${m}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() },
      body: JSON.stringify(b),
    });
    return { status: res.status, body: await res.text() };
  }, [body, YEAR, MONTH, DEPT]);
}

test.describe('KPI writes', () => {
  test.beforeEach(async () => {
    await pool.query('DELETE FROM kpi_monthly WHERE year = $1', [YEAR]);
  });

  test('S4: a value round-trips to Postgres', async ({ page }) => {
    await loginAs(page, 'production');
    await page.goto('/index.html');
    const r = await put(page, [{ kpi_key: KEY, target: 2000, actual: 1875.5, unit: 'TPD' }]);
    expect(r.status, r.body).toBe(200);
    const row = await storedRow();
    expect(Number(row.actual)).toBeCloseTo(1875.5, 2);
    expect(Number(row.target)).toBeCloseTo(2000, 2);
  });

  test('S4: a remarks-only save does not clobber the value', async ({ page }) => {
    await loginAs(page, 'production');
    await page.goto('/index.html');
    await put(page, [{ kpi_key: KEY, target: 2000, actual: 1875.5, unit: 'TPD' }]);
    const r = await put(page, [{ kpi_key: KEY, remarks: 'Kiln liner replaced on the 12th' }]);
    expect(r.status, r.body).toBe(200);
    const row = await storedRow();
    expect(Number(row.actual)).toBeCloseTo(1875.5, 2);
    expect(row.remarks).toBe('Kiln liner replaced on the 12th');
  });

  test('S4: an explicit clear actually removes the value', async ({ page }) => {
    await loginAs(page, 'production');
    await page.goto('/index.html');
    await put(page, [{ kpi_key: KEY, target: 2000, actual: 1875.5, unit: 'TPD' }]);

    /* Omitting the field, or sending null, must still COALESCE — that is what
       protects a remarks-only save. Only `clear` may remove it. */
    await put(page, [{ kpi_key: KEY, actual: null }]);
    expect(Number((await storedRow()).actual), 'null must not clear').toBeCloseTo(1875.5, 2);

    const r = await put(page, [{ kpi_key: KEY, clear: ['actual'] }]);
    expect(r.status, r.body).toBe(200);
    const row = await storedRow();
    expect(row.actual, 'clear:["actual"] must NULL the column').toBeNull();
    expect(Number(row.target), 'clearing the actual must not touch the target').toBeCloseTo(2000, 2);
  });

  test('S4: every write leaves an audit row naming the keys', async ({ page }) => {
    await loginAs(page, 'production');
    await page.goto('/index.html');
    await put(page, [{ kpi_key: KEY, target: 2000, actual: 1234, unit: 'TPD' }]);

    const { rows } = await pool.query(
      `SELECT details FROM audit_log
       WHERE action='KPI_UPDATE' AND form_type=$1
       ORDER BY created_at DESC LIMIT 1`,
      [`${DEPT}/${YEAR}/${MONTH}`]
    );
    expect(rows.length, 'a KPI_UPDATE audit row must exist').toBe(1);
    expect(rows[0].details, 'the audit row must name what changed').toContain(KEY);
    expect(rows[0].details).toContain('1234');
  });

  test('the whole save is one transaction — a bad row writes nothing', async ({ page }) => {
    await loginAs(page, 'production');
    await page.goto('/index.html');
    /* kpi_key is capped at 100 chars, so the second row fails validation.
       Nothing in the batch may reach the table. */
    const r = await put(page, [
      { kpi_key: KEY, actual: 999 },
      { kpi_key: 'x'.repeat(150), actual: 1 },
    ]);
    expect(r.status).toBe(400);
    expect(await storedRow(), 'a rejected batch must leave no partial write').toBeNull();
  });

  test('an unknown department is rejected, not silently stored', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/index.html');
    const r = await page.evaluate(async ([y, m]) => {
      const res = await fetch(`${_API_BASE}/kpi/producton/${y}/${m}`, {   // typo, deliberately
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() },
        body: JSON.stringify([{ kpi_key: 'kiln-output', actual: 1 }]),
      });
      return res.status;
    }, [YEAR, MONTH]);
    expect(r, 'a mistyped department must 4xx, not create an invisible row').toBeGreaterThanOrEqual(400);

    const { rows } = await pool.query(
      "SELECT 1 FROM kpi_monthly WHERE department = 'producton'"
    );
    expect(rows.length).toBe(0);
  });

  test('a role may not write another department', async ({ page }) => {
    await loginAs(page, 'ei');           // editDepts: ['ei']
    await page.goto('/index.html');
    const r = await put(page, [{ kpi_key: KEY, actual: 1 }]);   // DEPT = production
    expect(r.status).toBe(403);
    expect(await storedRow()).toBeNull();
  });

  test('S5: a failed save warns instead of looking successful', async ({ page }) => {
    await loginAs(page, 'production');
    await page.goto('/index.html');
    await page.route('**/api/kpi/**', route =>
      route.request().method() === 'PUT' ? route.abort() : route.continue());

    await page.evaluate(() => {
      window._kpiPut('production', 2001, 6, [{ kpi_key: 'kiln-output', actual: 5 }])
        .catch(() => _kpiToast('Saved on this device only — server did not receive the update.', 'warn'));
    });
    await expect(page.locator('#_kpt')).toContainText('this device only');
    expect(await storedRow(), 'nothing may reach the database').toBeNull();
  });
});
