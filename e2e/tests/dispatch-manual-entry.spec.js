/*
  The half of the Dispatch & SO report that Odoo cannot supply.

  Odoo fills the channel×grade tonnage. SO Pendency, Bags Packed, Burst Bag
  Rate and the 8 AM vehicle queue are counted by the packing plant and can
  only be typed in. On 2026-09-28 none of them had ever been entered on any
  of the 208 stored dispatch days — not because nobody tried, but because
  odooDispatchSync.js inserted every day it pulled as 'approved', and
  routes/reports.js refuses a submit over an 'approved' (or
  'pending_approval') report with REPORT_LOCKED. The report was locked on
  every date that existed, so the four review-page cards reading "No data"
  were reporting an impossibility rather than an omission.

  The sync now creates untouched days as 'draft'. This proves the whole path
  works for the role that actually does the work: Odoo's tonnage is already
  on the day, the officer adds the manual half, it saves, and it comes back.

  Writes to a 1999 date, cleaned up here and by global-teardown.
*/
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const D = '1999-06-17';

/* The fields only a human can supply — one from each of the four cards. */
const MANUAL = {
  so_425r:                 5566,
  so_425nbm:               242,
  bags_pl1:                24000,
  bags_pl2:                1200,
  burst_rate_pl1:          0.12,
  veh_reg_outside_waiting: 114,
};

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
}

/* Seeds the day exactly as the Odoo sync now leaves it: tonnage present,
   status 'draft', no human involved. */
async function seedOdooDay() {
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_at, status)
     VALUES ('dispatch', $1, 'day', $2::jsonb, NOW(), 'draft')
     ON CONFLICT (form_type, record_date, shift)
     DO UPDATE SET data = EXCLUDED.data, status = 'draft',
                   submitted_by = NULL, approved_by = NULL, updated_by = NULL`,
    [D, JSON.stringify({ dispatch_reg_425r: 2271.5, dispatch_reg_425nbm: 150 })]);
}

async function post(page, body) {
  return page.evaluate(async (b) => {
    const res = await fetch(`${_API_BASE}/reports/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() },
      body: JSON.stringify(b),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);
}

test.beforeEach(async () => { await cleanup(); await seedOdooDay(); });
test.afterAll(cleanup);

test('a packing officer can fill the manual half of an Odoo-synced day', async ({ page }) => {
  await loginAs(page, 'packing_officer');
  await page.goto('/index.html');

  const r = await post(page, { date: D, shift: 'day', data: MANUAL });
  expect(r.status, JSON.stringify(r.body)).toBe(200);

  const { rows } = await pool.query(
    `SELECT data, status FROM daily_reports
     WHERE form_type='dispatch' AND record_date=$1 AND shift='day'`, [D]);
  const row = rows[0];

  // Every manual field stored, as entered.
  for (const [k, v] of Object.entries(MANUAL)) {
    expect(Number(row.data[k]), `${k} must be stored`).toBe(v);
  }
  // …and Odoo's tonnage is still there: the submit MERGES, never replaces.
  expect(Number(row.data.dispatch_reg_425r)).toBe(2271.5);
  expect(Number(row.data.dispatch_reg_425nbm)).toBe(150);

  // An officer's submit lands awaiting the HOD's signature.
  expect(row.status).toBe('pending_approval');
});

test('the pre-2026-09-28 regression: an approved synced day refuses the manual half', async ({ page }) => {
  /* Recreates the exact state the sync used to leave behind. If someone
     sets the sync back to 'approved', this is what the packing plant hits —
     a 409 they cannot clear, on every single date. */
  await pool.query(
    `UPDATE daily_reports SET status='approved'
     WHERE form_type='dispatch' AND record_date=$1 AND shift='day'`, [D]);

  await loginAs(page, 'packing_officer');
  await page.goto('/index.html');

  const r = await post(page, { date: D, shift: 'day', data: MANUAL });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('REPORT_LOCKED');

  const { rows } = await pool.query(
    `SELECT data FROM daily_reports WHERE form_type='dispatch' AND record_date=$1 AND shift='day'`, [D]);
  expect(rows[0].data.bags_pl1, 'nothing of the manual half got through').toBeUndefined();
});
