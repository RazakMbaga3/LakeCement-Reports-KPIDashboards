/*
  Correction requests — what a person actually sees and does.

  A report that is approved (or waiting for sign-off) is locked. Until this
  feature, a mistake found afterwards had exactly one remedy: ask an HOD to
  reject the report, or ask a developer. Now the author asks, an approver who is
  NOT the author decides, and a time-boxed window opens in which the author can
  fix it and resubmit.

  The API rules — separation of duties, one open request per day, the sweeper's
  restore, the audit trail — are held by backend/scripts/accept-amendments.js
  (92 checks against a real server). This file holds what only a browser can:

    - the button appears when it should, and ONLY when it should
    - the request is asked for in words an approver can act on
    - the requester's OPEN form notices the grant by itself, without a reload
    - inside the window the form is editable and Save Draft does NOT un-approve
    - a submission closes the window and puts the report back in the queue
    - a decline is explained to the person who asked, on their own form
    - an HOD cannot grant their own request — the queue simply does not offer it
    - when the window runs out the screen agrees with the server, and the
      sweeper restores the figures
    - a dropped connection says so, and sends nothing (a governance act with a
      reason and a moment is never queued and replayed hours later)

  Driven on forms/pile-quality-form.html: Production's, single-owner, and not a
  page any other work is mid-edit on. Writes go to 1999 dates and are cleaned up.
*/
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { setReportDate } = require('../fixtures/forms');
const { pool } = require('../fixtures/db');

const FORM = 'pile-quality';
const PAGE = '/forms/pile-quality-form.html';
const D  = '1999-09-01';
const D2 = '1999-09-02';
const D3 = '1999-09-03';
const REASON = 'Kiln CaO reading was keyed from the wrong sample sheet';

async function cleanup() {
  await pool.query("DELETE FROM report_amendments WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  await pool.query("DELETE FROM report_revisions  WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  await pool.query("DELETE FROM daily_reports     WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  await pool.query("DELETE FROM audit_log WHERE username = 'system' AND record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  /* The sweeper's revert raises an 'amendment-expired:<form>' alert through the
     watchdog. Scoped by the sandbox date in its detail text, so a real alert
     can never be caught. */
  await pool.query("DELETE FROM alerts WHERE kind LIKE 'amendment-expired:%' AND detail LIKE '%for 1999-%'");
}
test.beforeEach(cleanup);
test.afterAll(cleanup);

/* ── seeding and reading the database ────────────────────────────────────── */

async function seedReport(status, data, { by = 'e2e_production', date = D } = {}) {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [by]);
  const approved = status === 'approved';
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status, approved_by, approved_at)
     VALUES ($1, $2, 'day', $3, $4, NOW(), $5, $6, $7)
     ON CONFLICT (form_type, record_date, shift) DO UPDATE
       SET data = EXCLUDED.data, status = EXCLUDED.status,
           approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`,
    [FORM, date, JSON.stringify(data), rows[0].id, status, approved ? rows[0].id : null, approved ? new Date() : null]);
}
const report = (date = D) => pool.query(
  'SELECT status, approved_by, data FROM daily_reports WHERE form_type = $1 AND record_date = $2', [FORM, date]).then(r => r.rows[0]);
const amendments = () => pool.query(
  `SELECT * FROM report_amendments WHERE form_type = $1 AND record_date BETWEEN '1999-09-01' AND '1999-09-30' ORDER BY id`, [FORM]).then(r => r.rows);
const revisions = (date = D) => pool.query(
  'SELECT * FROM report_revisions WHERE form_type = $1 AND record_date = $2 ORDER BY revision', [FORM, date]).then(r => r.rows);

/* ── driving the pages ───────────────────────────────────────────────────── */

async function openForm(page, role, date, opts = {}) {
  const errors = collectErrors(page);
  // Both are read at call time, so a spec does not have to wait 45 s / 20 s of real time.
  await page.addInitScript(o => {
    if (o.poll) window.NYATI_AMEND_POLL_MS = o.poll;
    if (o.auto) window.NYATI_AUTOSAVE_MS = o.auto;
  }, { poll: opts.poll, auto: opts.auto });
  await loginAs(page, role);
  await page.goto(PAGE);
  await page.waitForLoadState('networkidle');
  await setReportDate(page, date);
  return errors;
}

/* Answer window.prompt / confirm / alert. `script.prompt` is read at the moment
   a dialog opens, so a test can change what the next one says. */
function answer(page, script = {}) {
  const log = [];
  page.on('dialog', async d => {
    log.push({ type: d.type(), message: d.message() });
    if (d.type() === 'prompt') await d.accept(script.prompt == null ? '' : String(script.prompt));
    else await d.accept();
  });
  return log;
}

const pill   = page => page.locator('.rpt-pill');
const banner = page => page.locator('#_nyb');
const toast  = page => page.locator('#_nyt');
const askBtn = page => page.locator('#_ny-amend-btn');
const cao    = page => page.locator('input[data-field="cao_h1"]');

async function approvalsRow(page, date = D) {
  await page.goto('/approvals.html');
  await page.waitForLoadState('networkidle');
  const section = page.locator('#amd-section');
  await expect(section, 'the correction queue is on the approvals page').toBeVisible();
  return page.locator(`#amd-table tbody tr[data-date="${date}"]`);
}

/* ══════════════════════════════════════════════════════════════════════════ */

test('a locked report offers the request — a draft does not, and neither does a view-only role', async ({ page, context }) => {
  await seedReport('approved', { cao_h1: 46.5 });
  await seedReport('draft', { cao_h1: 44 }, { date: D2 });

  const errors = await openForm(page, 'production_officer', D);
  await expect(pill(page)).toHaveText('APPROVED');
  await expect(askBtn(page), 'an approved report the officer submitted must offer a correction request').toBeVisible();
  await expect(askBtn(page)).toHaveText('Request a correction');

  await setReportDate(page, D2);
  await expect(pill(page)).toHaveText('DRAFT');
  await expect(askBtn(page), 'a draft is already editable — nothing to ask for').toHaveCount(0);
  await expect(page.locator('.btn-sub').first()).toBeEnabled();

  // A role that cannot submit this form gets the view-only shell, and no way to ask.
  const other = await context.newPage();
  await loginAs(other, 'logistics');
  await other.goto(PAGE);
  await other.waitForLoadState('networkidle');
  await setReportDate(other, D);
  await expect(other.locator('#dr-view-only-banner')).toHaveCount(1);
  await expect(other.locator('#_ny-amend-btn'), 'a view-only role must not be offered the request').toHaveCount(0);

  expect(errors(), 'uncaught errors').toEqual([]);
});

test('asking needs a real reason; then the form says the request is waiting', async ({ page }) => {
  await seedReport('approved', { cao_h1: 46.5 });
  await openForm(page, 'production_officer', D);
  await expect(pill(page)).toHaveText('APPROVED');

  const script = { prompt: 'no' };
  const dialogs = answer(page, script);

  await askBtn(page).click();
  await expect.poll(() => dialogs.some(d => d.type === 'alert'), { timeout: 5000 }).toBe(true);
  expect(dialogs.find(d => d.type === 'alert').message, 'a too-short reason is refused with an explanation')
    .toMatch(/at least 10 characters/);
  expect(await amendments(), 'nothing was sent for a reason that short').toHaveLength(0);

  script.prompt = REASON;
  await askBtn(page).click();
  await expect(banner(page)).toContainText('waiting for an approver');
  await expect(askBtn(page), 'the request button is replaced while one is open').toHaveCount(0);
  await expect(page.locator('#_ny-amend-wd')).toBeVisible();

  const rows = await amendments();
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('requested');
  expect(rows[0].reason).toBe(REASON);
  expect(rows[0].locked_status).toBe('approved');
  expect((await report()).status, 'asking changes nothing about the report').toBe('approved');
});

test('the approver grants it, the requester\'s OPEN form notices, edits, and resubmits', async ({ page, context }) => {
  await seedReport('approved', { cao_h1: 46.5 });
  const errors = await openForm(page, 'production_officer', D, { poll: 400 });
  await expect(pill(page)).toHaveText('APPROVED');
  const originalApprover = (await report()).approved_by;

  // ── the officer asks ──
  const officer = { prompt: REASON };
  answer(page, officer);
  await askBtn(page).click();
  await expect(banner(page)).toContainText('waiting for an approver');

  // ── the HOD, on another screen, sees it and grants 2 hours ──
  const hod = await context.newPage();
  const hodScript = { prompt: '2' };
  answer(hod, hodScript);
  await loginAs(hod, 'production');
  const row = await approvalsRow(hod);
  await expect(row).toContainText('E2E production (officer)');
  await expect(row).toContainText(REASON);
  await expect(row).toContainText('Waiting for an approver');
  await expect(row.locator('button[data-action="grant"]')).toBeVisible();
  await row.locator('button[data-action="grant"]').click();
  await expect(row).toContainText('Window open');

  // ── the officer's form was left open and simply changes ──
  await expect(pill(page), 'the requester must not have to reload to learn it was granted')
    .toHaveText('CORRECTION OPEN', { timeout: 15000 });
  await expect(banner(page)).toContainText('Correction window open until');
  await expect(cao(page)).toBeEditable();
  await expect(page.locator('.btn-sub').first()).toBeEnabled();
  await expect(toast(page)).toContainText('approved');

  /* THE POINT of the design: the report never left 'approved'. */
  let r = await report();
  expect(r.status, 'a grant must not change the report\'s status').toBe('approved');
  expect(r.approved_by).toBe(originalApprover);
  expect((await amendments())[0].status).toBe('granted');

  // ── Save Draft inside the window must NOT un-approve the day ──
  await cao(page).fill('47.25');
  await page.locator('.btn-save').first().click();
  await expect(toast(page)).toContainText('Draft saved');
  await expect(pill(page), 'saving progress inside a window must not repaint the report as a draft').toHaveText('CORRECTION OPEN');
  r = await report();
  expect(r.status, 'the day must keep counting while it is being corrected').toBe('approved');
  expect(String(r.data.cao_h1)).toBe('47.25');

  // ── submit the correction ──
  await cao(page).fill('47.5');
  await page.locator('.btn-sub').first().click();
  await expect(pill(page)).toHaveText('AWAITING SIGN-OFF', { timeout: 15000 });
  await expect(page.locator('.btn-sub').first(), 'the form locks again once the correction is in').toBeDisabled();
  await expect(askBtn(page), 'and the request button is back for next time').toBeVisible();

  r = await report();
  expect(r.status, 'an officer\'s resubmission re-enters approval').toBe('pending_approval');
  expect(r.approved_by).toBeNull();
  expect(String(r.data.cao_h1)).toBe('47.5');
  const am = (await amendments())[0];
  expect(am.status, 'the window is used up').toBe('applied');
  const applyRev = (await revisions()).find(v => v.action === 'FORM_SUBMIT' && v.amendment_id === am.id);
  expect(applyRev, 'the submission left a revision linked to the amendment').toBeTruthy();
  expect(String(applyRev.prior_data.cao_h1), 'and it holds what the figure WAS').toBe('47.25');

  expect(errors(), 'uncaught errors').toEqual([]);
});

test('a declined request is explained to the person who asked, on their own form', async ({ page, context }) => {
  await seedReport('approved', { cao_h1: 46.5 });
  await openForm(page, 'production_officer', D, { poll: 400 });
  await expect(pill(page)).toHaveText('APPROVED');

  answer(page, { prompt: REASON });
  await askBtn(page).click();
  await expect(banner(page)).toContainText('waiting for an approver');

  const hod = await context.newPage();
  const NOTE = 'The lab certificate matches the figure as it was submitted.';
  answer(hod, { prompt: NOTE });
  await loginAs(hod, 'production');
  const row = await approvalsRow(hod);
  await row.locator('button[data-action="decline"]').click();
  await expect(hod.locator('#amd-table tbody tr[data-date="1999-09-01"]'), 'a decided request leaves the queue').toHaveCount(0);

  await expect(banner(page), 'the requester is told why, without reloading').toContainText('declined', { timeout: 15000 });
  await expect(banner(page)).toContainText(NOTE);
  await expect(toast(page)).toContainText('declined');
  await expect(pill(page)).toHaveText('APPROVED');
  await expect(cao(page), 'a declined request unlocks nothing').not.toBeEditable();
  await expect(askBtn(page), 'they may ask again').toBeVisible();

  expect((await amendments())[0].status).toBe('declined');
  expect((await report()).status).toBe('approved');
});

test('an HOD cannot grant their own request — the queue does not offer it; an admin can', async ({ page, context }) => {
  await seedReport('approved', { cao_h1: 46.5 }, { by: 'e2e_production' });
  await openForm(page, 'production', D);                 // the HOD is the author here
  await expect(pill(page)).toHaveText('APPROVED');

  answer(page, { prompt: REASON });
  await askBtn(page).click();
  await expect(banner(page)).toContainText('waiting for an approver');

  const hodView = await context.newPage();
  await loginAs(hodView, 'production');
  const own = await approvalsRow(hodView);
  await expect(own).toContainText('Waiting for an approver');
  await expect(own.locator('button[data-action="withdraw"]'), 'they may take it back').toBeVisible();
  await expect(own.locator('button[data-action="grant"]'), 'the lock is advisory if you can sign off your own ask').toHaveCount(0);
  await expect(own.locator('button[data-action="decline"]')).toHaveCount(0);

  const adminView = await context.newPage();
  answer(adminView, { prompt: '1' });
  await loginAs(adminView, 'admin');
  const theirs = await approvalsRow(adminView);
  await expect(theirs.locator('button[data-action="grant"]'), 'admin is the escalation').toBeVisible();
  await theirs.locator('button[data-action="grant"]').click();
  await expect(theirs).toContainText('Window open');

  const am = (await amendments())[0];
  expect(am.status).toBe('granted');
  expect(am.decided_by_name).toBe('E2E admin (hod)');
  expect((await report()).status).toBe('approved');
});

test('when the window runs out the screen agrees with the server, and the sweeper restores the figures', async ({ page, context }) => {
  test.setTimeout(150000);
  await seedReport('approved', { cao_h1: 46.5 });

  // The request and the grant, made the way the buttons make them.
  const officer = await context.newPage();
  await loginAs(officer, 'production_officer');
  await officer.goto(PAGE);
  await officer.waitForLoadState('networkidle');
  const askedId = await officer.evaluate(async ([f, d, reason]) => (await NyatiAPI.requestAmendment(f, d, reason)).amendment.id,
    [FORM, D, REASON]);
  const hod = await context.newPage();
  await loginAs(hod, 'production');
  await hod.goto('/approvals.html');
  await hod.waitForLoadState('networkidle');
  await hod.evaluate(async ([f, d, id]) => NyatiAPI.grantAmendment(f, d, id, 1), [FORM, D, askedId]);
  // Shorten the window so the test does not sit through an hour: the client
  // counts down from the server's own seconds_left, so this is what it sees.
  await pool.query(`UPDATE report_amendments SET expires_at = NOW() + INTERVAL '14 seconds' WHERE id = $1`, [askedId]);

  await openForm(page, 'production_officer', D, { auto: 300 });
  await expect(pill(page)).toHaveText('CORRECTION OPEN', { timeout: 10000 });

  // Half a correction, autosaved into an APPROVED report — the state the sweeper exists for.
  await cao(page).fill('47.9');
  await expect.poll(async () => String((await report()).data.cao_h1), { timeout: 8000 }).toBe('47.9');
  expect((await report()).status).toBe('approved');

  // ── the window closes on screen ──
  await expect(pill(page), 'the form must stop offering an editable form the server will refuse')
    .toHaveText('APPROVED', { timeout: 30000 });
  await expect(page.locator('.btn-sub').first()).toBeDisabled();
  await expect(cao(page)).not.toBeEditable();
  await expect(toast(page)).toContainText('correction window has closed');

  // ── the sweeper, through the same route the cron uses ──
  const admin = await context.newPage();
  await loginAs(admin, 'admin');
  const swept = await admin.evaluate(async () => {
    const res = await fetch(_API_BASE + '/monitor/watchdog/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() }, body: '{}' });
    return { status: res.status };
  });
  expect(swept.status).toBe(200);

  const r = await report();
  expect(String(r.data.cao_h1), 'the figure the report held when the window was granted is back').toBe('46.5');
  expect(r.status, 'its status was never touched').toBe('approved');
  expect((await amendments())[0].status).toBe('expired');
  const revert = (await revisions()).find(v => v.action === 'AMENDMENT_EXPIRE_REVERT');
  expect(revert, 'the revert is a revision').toBeTruthy();
  expect(String(revert.prior_data.cao_h1), 'and it KEEPS what the author typed').toBe('47.9');

  // A fresh visit says what happened, instead of quietly showing the old figure.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await setReportDate(page, D);
  await expect(pill(page)).toHaveText('APPROVED');
  await expect(banner(page)).toContainText('closed unused');
  await expect(cao(page)).toHaveValue('46.5');
});

test('a Save Draft that FAILS inside a window must not leave the form thinking it is a draft', async ({ page, context }) => {
  /* Inside a window the server keeps the report's status, so the form must not
     paint itself as a draft while it saves. The pill cannot show the difference
     (inside a window it keys on the window, not the status); what can is the
     form's own idea of the report's status, which the window's END depends on.
     If a save fails, nothing corrects a wrongly-painted 'draft' — and when the
     window then closes, a form that believes it is a draft UNLOCKS ITSELF over a
     report the server still holds as approved. */
  test.setTimeout(150000);
  await seedReport('approved', { cao_h1: 46.5 });

  const officer = await context.newPage();
  await loginAs(officer, 'production_officer');
  await officer.goto(PAGE);
  await officer.waitForLoadState('networkidle');
  const askedId = await officer.evaluate(async ([f, d, reason]) => (await NyatiAPI.requestAmendment(f, d, reason)).amendment.id,
    [FORM, D, REASON]);
  const hod = await context.newPage();
  await loginAs(hod, 'production');
  await hod.goto('/approvals.html');
  await hod.waitForLoadState('networkidle');
  await hod.evaluate(async ([f, d, id]) => NyatiAPI.grantAmendment(f, d, id, 1), [FORM, D, askedId]);
  await pool.query(`UPDATE report_amendments SET expires_at = NOW() + INTERVAL '16 seconds' WHERE id = $1`, [askedId]);

  await openForm(page, 'production_officer', D);
  await expect(pill(page)).toHaveText('CORRECTION OPEN', { timeout: 10000 });

  await cao(page).fill('47.9');
  await context.setOffline(true);
  await page.locator('.btn-save').first().click();
  await expect(toast(page)).toContainText('kept on this device', { timeout: 10000 });
  await context.setOffline(false);

  await expect(pill(page)).toHaveText('APPROVED', { timeout: 30000 });
  await expect(page.locator('.btn-sub').first(),
    'the window closed: the form must lock, not unlock itself as a draft').toBeDisabled();
  await expect(cao(page)).not.toBeEditable();
  expect((await report()).status).toBe('approved');
});

test('a dropped connection says so and sends nothing', async ({ page, context }) => {
  await seedReport('approved', { cao_h1: 46.5 });
  await openForm(page, 'production_officer', D);
  await expect(pill(page)).toHaveText('APPROVED');
  answer(page, { prompt: REASON });

  await context.setOffline(true);
  await askBtn(page).click();
  await expect(toast(page)).toContainText('needs the server');
  await expect(toast(page), 'it must say the request was NOT sent').toContainText('was not sent');
  await context.setOffline(false);

  expect(await amendments(), 'a governance act is never queued and replayed hours later').toHaveLength(0);
  await expect(askBtn(page), 'and they can simply try again').toBeVisible();
});

test('the request button lives in the persist layer, not in 11 pages of markup', async () => {
  /* It is created in JS with an id, not written into markup and found by a
     style class. forms/form-persist.js binds nothing by `.btn-out` any more
     precisely because it once did — and the button that swallowed seven pages'
     Save Draft was an `.btn-out`. The static form-hooks test scans markup for
     controls; this keeps the new one out of its reach by construction. */
  const roots = ['../..', '../../forms'];   // repo root and forms/, from e2e/tests
  for (const dir of roots) {
    const base = path.join(__dirname, dir);
    for (const f of fs.readdirSync(base).filter(n => n.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(base, f), 'utf8');
      expect(html, `${f} must not carry the request button in its markup`).not.toContain('_ny-amend-btn');
    }
  }
  const persist = fs.readFileSync(path.join(__dirname, '../../forms/form-persist.js'), 'utf8');
  expect(persist).toContain("btn.id = '_ny-amend-btn'");
});
