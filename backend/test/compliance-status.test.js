/*
  test/compliance-status.test.js — the compliance status engine
  (services/complianceStatus.js): the one place Active / Due / Overdue is
  decided, so its boundaries are pinned here day by day.

  Pure: no server, no Postgres. Usage: node --test test/compliance-status.test.js
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../services/complianceStatus');

const TODAY = '2026-10-12';
const ctx = (extra) => Object.assign({ today: TODAY, settings: {}, openPeriods: [], hasDirect: true }, extra || {});
const validity = (o) => Object.assign({ kind: 'validity', lifecycle: 'active', verified_at: '2026-10-12T00:00:00Z' }, o);

test('todayIn is the calendar day in Dar es Salaam, not UTC', () => {
  // 20:59 UTC on the 12th is 23:59 EAT on the 12th; 21:01 UTC is already the 13th in EAT.
  assert.equal(S.todayIn(undefined, Date.UTC(2026, 9, 12, 20, 59)), '2026-10-12');
  assert.equal(S.todayIn(undefined, Date.UTC(2026, 9, 12, 21, 1)), '2026-10-13');
});

test('validity boundaries: lead+1 active, lead due, deadline day due, day after overdue', () => {
  const lead = 45;
  const at = (daysLeft) => S.computeStatus(validity({ valid_to: S.addDays(TODAY, daysLeft), lead_days_1: lead, lead_days_2: 30, lead_days_3: 20 }), ctx());
  assert.equal(at(lead + 1).status, 'active');
  assert.equal(at(lead).status, 'due');
  assert.equal(at(lead).stage, 'D');
  assert.equal(at(30).stage, 'S');
  assert.equal(at(20).stage, 'H');
  assert.equal(at(0).status, 'due', 'the deadline day itself is still Due');
  assert.equal(at(-1).status, 'overdue');
  assert.equal(at(-1).stage, 'OD0');
  assert.equal(at(-7).stage, 'OD0');
  assert.equal(at(-8).stage, 'OD1');
});

test('lead 0 means due only on the deadline day', () => {
  const r = S.computeStatus(validity({ valid_to: S.addDays(TODAY, 1), lead_days_1: 0, lead_days_2: 0, lead_days_3: 0 }), ctx());
  assert.equal(r.status, 'active');
  assert.equal(S.computeStatus(validity({ valid_to: TODAY, lead_days_1: 0, lead_days_2: 0, lead_days_3: 0 }), ctx()).status, 'due');
});

test('default leads: 45/30/20 for a short term, 90/60/45 for a term of two years or more', () => {
  assert.deepEqual(S.effectiveLeads(validity({ valid_from: '2026-01-01', valid_to: '2026-12-31' }), {}), [45, 30, 20]);
  assert.deepEqual(S.effectiveLeads(validity({ valid_from: '2021-03-31', valid_to: '2031-03-30' }), {}), [90, 60, 45]);
  assert.deepEqual(S.effectiveLeads({ kind: 'recurring', rec_unit: 'month' }, {}), [7, 5, 2]);
  assert.deepEqual(S.effectiveLeads({ kind: 'condition' }, {}), [14, 7, 3]);
});

test('no expiry is active; no valid_to is "No date set"; inactive and archived are their own buckets', () => {
  assert.equal(S.computeStatus(validity({ no_expiry: true }), ctx()).status, 'active');
  assert.equal(S.computeStatus(validity({}), ctx()).status, 'undated');
  assert.equal(S.computeStatus(validity({ valid_to: '2020-01-01', lifecycle: 'inactive' }), ctx()).status, 'inactive');
  assert.equal(S.computeStatus(validity({ valid_to: '2020-01-01', lifecycle: 'archived' }), ctx()).status, 'archived');
});

test('flags never change the status', () => {
  const r = S.computeStatus(validity({ valid_to: '2025-05-27', verified_at: null, renewal_in_progress: true }), ctx({ hasDirect: false }));
  assert.equal(r.status, 'overdue');
  assert.deepEqual(r.flags, { unverified: true, renewalInProgress: true, noExpiry: false, missingDirect: true });
});

test('renewal in progress: no pre-deadline reminders, overdue nags every 14 days', () => {
  const due = S.computeStatus(validity({ valid_to: S.addDays(TODAY, 10), renewal_in_progress: true }), ctx());
  assert.equal(due.status, 'due');
  assert.equal(due.stage, null);
  const od = (n) => S.computeStatus(validity({ valid_to: S.addDays(TODAY, -n), renewal_in_progress: true }), ctx()).stage;
  assert.equal(od(1), 'OD0');
  assert.equal(od(14), 'OD0');
  assert.equal(od(15), 'OD1');
});

test('month-end clamp: the 30th in February, the 31st in April', () => {
  const vat = { kind: 'recurring', rec_unit: 'month', rec_due_day: 30, track_from: '2027-01-01' };
  const d = S.dueDatesFrom(vat, '2027-01-01', due => due >= '2028-03-01');
  assert.ok(d.includes('2027-02-28'), '2027 is not a leap year');
  assert.ok(d.includes('2028-02-29'), '2028 is');
  const apr = S.dueDatesFrom({ kind: 'recurring', rec_unit: 'month', rec_due_day: 31 }, '2027-04-01', due => due >= '2027-04-30');
  assert.equal(apr[0], '2027-04-30');
});

test('quarters anchor on rec_due_month; half-years and every-N-years', () => {
  const q1 = S.dueDatesFrom({ kind: 'recurring', rec_unit: 'quarter', rec_due_day: 7, rec_due_month: 1 }, '2026-01-01', d => d >= '2026-12-01');
  assert.deepEqual(q1, ['2026-01-07', '2026-04-07', '2026-07-07', '2026-10-07', '2027-01-07']);
  const q3 = S.dueDatesFrom({ kind: 'recurring', rec_unit: 'quarter', rec_due_day: 30, rec_due_month: 3 }, '2026-01-01', d => d >= '2026-12-01');
  assert.deepEqual(q3, ['2026-03-30', '2026-06-30', '2026-09-30', '2026-12-30']);
  assert.equal(S.periodKey({ rec_unit: 'quarter' }, '2026-10-07'), '2026-Q4');
  const h = S.dueDatesFrom({ kind: 'recurring', rec_unit: 'half', rec_due_day: 15, rec_due_month: 1 }, '2026-01-01', d => d >= '2027-01-01');
  assert.deepEqual(h, ['2026-01-15', '2026-07-15', '2027-01-15']);
  const y3 = S.dueDatesFrom({ kind: 'recurring', rec_unit: 'years', rec_interval: 3, rec_anchor_date: '2020-05-01' }, '2024-01-01', d => d >= '2028-01-01');
  assert.deepEqual(y3, ['2026-05-01', '2029-05-01']);
});

test('periods are generated from track_from only, through the first one past the horizon', () => {
  const item = { kind: 'recurring', rec_unit: 'month', rec_due_day: 20, track_from: TODAY };
  const p = S.periodsToCreate(item, TODAY, new Set(), {});
  assert.deepEqual(p.map(x => x.period_key), ['2026-10', '2026-11']);
  assert.deepEqual(S.periodsToCreate(item, TODAY, new Set(['2026-10', '2026-11']), {}), []);
});

test('a missed period keeps the item overdue after the next one is generated', () => {
  const item = { kind: 'recurring', rec_unit: 'month', rec_due_day: 7, lifecycle: 'active', verified_at: 'x' };
  const r = S.computeStatus(item, ctx({ openPeriods: [
    { period_key: '2026-11', due_on: '2026-11-07' },
    { period_key: '2026-10', due_on: '2026-10-07' },
  ] }));
  assert.equal(r.status, 'overdue');
  assert.equal(r.deadline, '2026-10-07');
  const done = S.computeStatus(item, ctx({ openPeriods: [{ period_key: '2026-11', due_on: '2026-11-07' }] }));
  assert.equal(done.status, 'active');
});

test('recurring with no due day is "No date set"; on-demand with nothing open is active', () => {
  assert.equal(S.computeStatus({ kind: 'recurring', rec_unit: 'month', lifecycle: 'active' }, ctx()).status, 'undated');
  assert.equal(S.computeStatus({ kind: 'recurring', rec_unit: 'on_demand', lifecycle: 'active' }, ctx()).status, 'active');
});

test('conditions: not complied is overdue, partial at least due, not applicable inactive', () => {
  const c = (o) => S.computeStatus(Object.assign({ kind: 'condition', lifecycle: 'active' }, o), ctx());
  assert.equal(c({ condition_result: 'not_complied', condition_assessed_on: TODAY }).status, 'overdue');
  assert.equal(c({ condition_result: 'not_complied', condition_assessed_on: TODAY }).stage, 'OD0');
  assert.equal(c({ condition_result: 'partial', next_review_on: '2027-06-01' }).status, 'due');
  assert.equal(c({ condition_result: 'not_applicable' }).status, 'inactive');
  assert.equal(c({ condition_result: 'complied', next_review_on: '2027-06-01' }).status, 'active');
  assert.equal(c({ condition_result: 'complied', next_review_on: '2026-10-01' }).status, 'overdue');
  assert.equal(c({ condition_result: 'complied' }).status, 'undated');
});

test('audiences are cumulative', () => {
  assert.deepEqual(S.audiencesFor('D'), ['direct']);
  assert.deepEqual(S.audiencesFor('S'), ['direct', 'second']);
  assert.deepEqual(S.audiencesFor('H'), ['direct', 'second', 'head']);
  assert.deepEqual(S.audiencesFor('OD3'), ['direct', 'second', 'head']);
  assert.deepEqual(S.audiencesFor(null), []);
});
