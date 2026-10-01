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

  That was first fixed by making the sync write 'draft' instead — which
  unlocked entry and broke the dashboard, since 'draft' is outside
  REPORTED_STATUSES and dispatch.html then counted no day at all. The real
  error was reading `status` as the record of whether a report had been
  signed. It is not; `approved_by` is. Since 2026-10-01 the lock tests
  approved_by, so an ERP row (approved_by NULL) stays writable while saying
  the true thing about itself — Odoo approved this — and the dashboard reads
  it. See DEC-008.

  This proves the whole path works for the role that does the work: Odoo's
  tonnage is already on the day, the officer adds the manual half, it saves,
  and it comes back.

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
     VALUES ('dispatch', $1, 'day', $2::jsonb, NOW(), 'approved')
     ON CONFLICT (form_type, record_date, shift)
     DO UPDATE SET data = EXCLUDED.data, status = 'approved',
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

/* The lock tests approved_by, not status (2026-10-01, DEC-008). These two
   are the pair that has to hold together: an ERP row is writable even though
   it says 'approved', and a row a PERSON approved is not. Getting either one
   wrong is a real outage — the first locks the packing plant out of their own
   report, the second lets anyone silently overwrite a signed-off one. */

test("a day the ERP approved is still writable — there is no human signature to protect", async ({ page }) => {
  /* This is the state the sync leaves behind on every date: status
     'approved', approved_by NULL. Before DEC-008 this returned a 409 the
     packing plant could not clear, on all 211 days. */
  const { rows: before } = await pool.query(
    `SELECT status, approved_by FROM daily_reports
     WHERE form_type='dispatch' AND record_date=$1 AND shift='day'`, [D]);
  expect(before[0].status).toBe('approved');
  expect(before[0].approved_by, 'the ERP signs nothing').toBeNull();

  await loginAs(page, 'packing_officer');
  await page.goto('/index.html');

  const r = await post(page, { date: D, shift: 'day', data: MANUAL });
  expect(r.status, JSON.stringify(r.body)).toBe(200);

  const { rows } = await pool.query(
    `SELECT data FROM daily_reports WHERE form_type='dispatch' AND record_date=$1 AND shift='day'`, [D]);
  expect(Number(rows[0].data.bags_pl1)).toBe(MANUAL.bags_pl1);
});

test('a day a PERSON approved is still locked — the signature is what the lock protects', async ({ page }) => {
  /* The case the write-lock was actually written for. Same status as the
     test above; the only difference is that approved_by is set. */
  const { rows: approver } = await pool.query(
    `SELECT id FROM users WHERE username = $1`, ['e2e_logistics']);
  await pool.query(
    `UPDATE daily_reports SET status='approved', approved_by=$2, approved_at=NOW()
     WHERE form_type='dispatch' AND record_date=$1 AND shift='day'`, [D, approver[0].id]);

  await loginAs(page, 'packing_officer');
  await page.goto('/index.html');

  const r = await post(page, { date: D, shift: 'day', data: MANUAL });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('REPORT_LOCKED');

  const { rows } = await pool.query(
    `SELECT data FROM daily_reports WHERE form_type='dispatch' AND record_date=$1 AND shift='day'`, [D]);
  expect(rows[0].data.bags_pl1, 'a signed-off report must not be overwritten').toBeUndefined();
});
