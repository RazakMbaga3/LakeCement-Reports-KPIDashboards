/*
  test/compliance-reminders.test.js — who gets reminded, and what the email
  says (services/complianceReminders.js planReminders + services/complianceMail.js),
  and the access rules (config/complianceAccess.js).

  Pure: no server, no Postgres. The live run — outbox rows, exactly-once,
  retries, real sends through jsonTransport — is covered end to end by
  scripts/accept-compliance.js.
  Usage: node --test test/compliance-reminders.test.js
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../services/complianceStatus');
const { planReminders } = require('../services/complianceReminders');
const { composeReminder, statusPhrase } = require('../services/complianceMail');
const A = require('../config/complianceAccess');

const TODAY = '2026-10-12';
function item(o) {
  const it = Object.assign({
    id: 1, kind: 'validity', owner_role: 'pm', lifecycle: 'active', reminders_enabled: true, verified_at: 'x',
    title: 'OVER HEAD CRANE :SWL-10 TON', departmentLabel: 'Projects & Maintenance', agency: 'OSHA',
    direct: [{ contactId: 1, name: 'Rawat', email: 'rawat@lakecement.co.tz' }],
    second: [{ contactId: 2, name: 'Pavan Gandhi', email: 'pavan@lakecement.co.tz' }],
  }, o);
  it.computed = S.computeStatus(it, { today: TODAY, settings: {}, openPeriods: [], hasDirect: it.direct.length > 0 });
  return it;
}
const ctx = (o) => Object.assign({
  heads: [{ contactId: 9, name: 'MD Office', email: 'md@lakecement.co.tz' }],
  hods: new Map([['pm', [{ userId: 77, name: 'P&M HOD', email: 'pm.hod@lakecement.co.tz' }]]]),
  settings: {}, globalEnabled: true,
}, o);
const days = n => S.addDays(TODAY, n);

test('stage D reaches only the responsible person; S adds the supervisor; H adds the Head list', () => {
  const at = n => planReminders([item({ valid_to: days(n), lead_days_1: 45, lead_days_2: 30, lead_days_3: 20 })], ctx());
  assert.deepEqual(at(50), [], 'outside every window: nothing');
  assert.deepEqual(at(45).map(r => r.audience), ['direct']);
  assert.deepEqual(at(30).map(r => r.audience), ['direct', 'second']);
  assert.deepEqual(at(20).map(r => [r.audience, r.recipient_key]), [['direct', 'c:1'], ['second', 'c:2'], ['head', 'c:9']]);
  assert.ok(at(20).every(r => r.stage === 'H' && r.deadline === days(20) && r.status === 'pending'));
});

test('overdue reaches all three, with a stage that advances weekly', () => {
  const r1 = planReminders([item({ valid_to: days(-1) })], ctx());
  assert.deepEqual(r1.map(r => r.audience), ['direct', 'second', 'head']);
  assert.ok(r1.every(r => r.stage === 'OD0'));
  assert.ok(planReminders([item({ valid_to: days(-8) })], ctx()).every(r => r.stage === 'OD1'));
});

test('held, skipped and disabled rows are planned with their reason, never as pending', () => {
  assert.ok(planReminders([item({ valid_to: days(-1), verified_at: null })], ctx()).every(r => r.status === 'held_unverified'));
  assert.ok(planReminders([item({ valid_to: days(-1) })], ctx({ globalEnabled: false })).every(r => r.status === 'skipped_disabled'));
  assert.ok(planReminders([item({ valid_to: days(-1), reminders_enabled: false })], ctx()).every(r => r.status === 'skipped_disabled'));
  const noMail = planReminders([item({ valid_to: days(-1), direct: [{ contactId: 1, name: 'Rawat', email: null }] })], ctx());
  assert.equal(noMail.find(r => r.audience === 'direct').status, 'skipped_no_email');
});

test('no responsible person: the owning department\'s HOD is the fallback', () => {
  const r = planReminders([item({ valid_to: days(10), direct: [] })], ctx());
  assert.equal(r[0].recipient_key, 'u:77');
  const off = planReminders([item({ valid_to: days(10), direct: [] })], ctx({ settings: { hod_fallback: false } }));
  assert.equal(off.filter(x => x.audience === 'direct').length, 0, 'fallback off: no responsible-person row at all');
  assert.deepEqual(off.map(x => x.audience), ['second', 'head'], 'the supervisor and Head are still told');
});

test('one person named twice on a record gets one row', () => {
  const p = { contactId: 5, name: 'Sajivkumar PS', email: 'sajiv@lakecement.co.tz' };
  const r = planReminders([item({ valid_to: days(-3), direct: [p], second: [p] })], ctx());
  assert.equal(r.filter(x => x.recipient_key === 'c:5').length, 1);
});

test('renewal in progress: nothing before the deadline', () => {
  assert.deepEqual(planReminders([item({ valid_to: days(10), renewal_in_progress: true })], ctx()), []);
});

const entry = (o) => Object.assign({ id: 42, title: 'Business License - HO', kind: 'validity', department: 'HR & Admin', agency: 'BRELA',
  deadline: '2026-12-17', days_left: 66, status: 'due', audience: 'direct' }, o);

test('single-item email: the briefed subject, fields, RENEW NOW button and automated sender', () => {
  process.env.APP_URL = 'https://smr.lakecement.co.tz/';
  const { subject, html } = composeReminder({ recipientName: 'Marina', entries: [entry()] });
  assert.equal(subject, 'Compliance Renewal Reminder: Business License - HO');
  for (const s of ['Compliance Name', 'Business License - HO', 'Department', 'HR &amp; Admin', 'Expiry Date', '17 Dec 2026', 'Status', 'Due in 66 days', 'RENEW NOW', 'Compliance Master System']) {
    assert.ok(html.includes(s), `missing ${s}`);
  }
  assert.ok(html.includes('href="https://smr.lakecement.co.tz/compliance.html?item=42"'));
});

test('filings and reviews say what is asked of the reader', () => {
  assert.match(composeReminder({ entries: [entry({ kind: 'recurring' })] }).subject, /^Compliance Filing Reminder: /);
  assert.ok(composeReminder({ entries: [entry({ kind: 'recurring' })] }).html.includes('RECORD FILING'));
  assert.match(composeReminder({ entries: [entry({ kind: 'condition' })] }).subject, /^Compliance Review Reminder: /);
});

test('several items for one person: one consolidated email, overdue first', () => {
  const { subject, html } = composeReminder({ recipientName: 'Godhania', entries: [
    entry({ id: 1, title: 'Calibration - Oven', days_left: 10 }),
    entry({ id: 2, title: 'Calibration - Balance', status: 'overdue', days_left: -5 }),
  ] });
  assert.equal(subject, 'Compliance Reminder: 2 items need attention (1 overdue)');
  assert.ok(html.indexOf('Calibration - Balance') < html.indexOf('Calibration - Oven'));
});

test('titles are escaped; without APP_URL there is no button rather than a wrong link', () => {
  delete process.env.APP_URL;
  const { html } = composeReminder({ entries: [entry({ title: '<script>alert(1)</script>' })] });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('compliance.html?item='));
});

test('status phrases', () => {
  assert.equal(statusPhrase({ status: 'overdue', days_left: -1 }), 'Overdue by 1 day');
  assert.equal(statusPhrase({ status: 'due', days_left: 0 }), 'Due today');
  assert.equal(statusPhrase({ status: 'overdue', kind: 'condition', condition_result: 'not_complied' }), 'Not complied');
});

/* ── Access ─────────────────────────────────────────────────────────── */
const u = (role, level) => ({ role, level, id: 1 });
const pmItem = { owner_role: 'pm' };

test('a department sees and works on its own records only', () => {
  assert.equal(A.complianceAccess(u('pm', 'officer'), pmItem).read, true);
  assert.equal(A.complianceAccess(u('ei', 'hod'), pmItem).read, false);
  assert.equal(A.scopeRole(u('pm', 'officer')), 'pm');
});

test('levels: officer acts, senior edits and verifies, HOD archives and transfers', () => {
  const o = A.complianceAccess(u('pm', 'officer'), pmItem);
  const s = A.complianceAccess(u('pm', 'senior'), pmItem);
  const h = A.complianceAccess(u('pm', 'hod'), pmItem);
  assert.deepEqual([o.act, o.edit, o.verify, o.archive], [true, false, false, false]);
  assert.deepEqual([s.act, s.edit, s.verify, s.archive], [true, true, true, false]);
  assert.deepEqual([h.act, h.edit, h.verify, h.archive, h.transfer], [true, true, true, true, true]);
});

test('md / management read everything and write nothing; admin may fix but never verify', () => {
  for (const r of ['md', 'management']) {
    const a = A.complianceAccess(u(r, 'hod'), pmItem);
    assert.deepEqual([a.read, a.act, a.edit, a.verify], [true, false, false, false]);
    assert.equal(A.scopeRole(u(r, 'hod')), null);
  }
  const ad = A.complianceAccess(u('admin', 'hod'), pmItem);
  assert.deepEqual([ad.read, ad.act, ad.edit, ad.verify, ad.archive], [true, true, true, false, true]);
});

test('capabilities: import is admin only; settings are MD and admin', () => {
  assert.equal(A.capabilities(u('admin', 'hod')).canImport, true);
  assert.equal(A.capabilities(u('md', 'hod')).canImport, false);
  assert.equal(A.capabilities(u('md', 'hod')).canSettings, true);
  assert.equal(A.capabilities(u('management', 'hod')).canSettings, false);
  assert.equal(A.capabilities(u('pm', 'officer')).canCreate, false);
  assert.equal(A.capabilities(u('pm', 'senior')).canCreate, true);
});
