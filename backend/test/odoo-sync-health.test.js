/*
  test/odoo-sync-health.test.js — the verdicts GET /api/health gives for
  each scheduled Odoo pull (services/health.js's classifySync), plus the
  `only` filter on runOdooSync.

  Why this exists: on 2026-09-24 the Quarry report was found missing the
  22nd and 23rd, and nothing in the app could say whether pulling was even
  running — health read "pulling on schedule" whenever the URLs were set,
  even with the cron off. These pin the states that distinction depends on:
  a pull that never ran, one that's failing, one that's merely overdue, and
  one with no cron at all must each read as NOT ok, and a healthy or
  just-booted one must not raise a false alarm.

  No database, no Odoo.
  Usage: node --test test/odoo-sync-health.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');

const { classifySync } = require('../services/health');
const { runOdooSync }  = require('../services/odooSync');

const NOW = Date.parse('2026-09-24T10:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const LIVE  = { live: true,  daily: true  };
const DAILY = { live: false, daily: true  };
const OFF   = { live: false, daily: false };

test('no cron enabled for the pull -> not_scheduled, and not ok', () => {
  const v = classifySync({ last_success_at: minsAgo(1) }, OFF, { now: NOW });
  assert.equal(v.status, 'not_scheduled');
  assert.equal(v.ok, false);
});

test('never run: fine right after a boot, an alarm once the grace period has passed', () => {
  const justBooted = classifySync(undefined, LIVE, { now: NOW, uptimeS: 30 });
  assert.equal(justBooted.status, 'starting');
  assert.equal(justBooted.ok, true);

  const longRunning = classifySync(undefined, LIVE, { now: NOW, uptimeS: 3 * 3600 });
  assert.equal(longRunning.status, 'never_run');
  assert.equal(longRunning.ok, false);
});

test('a recent success is ok and reports its age', () => {
  const v = classifySync({ last_success_at: minsAgo(12) }, LIVE, { now: NOW });
  assert.equal(v.status, 'ok');
  assert.equal(v.ok, true);
  assert.equal(v.last_success_min_ago, 12);
});

test('overdue depends on how the pull is scheduled: 4h is stale for the half-hourly job, fine for the daily one', () => {
  const row = { last_success_at: minsAgo(4 * 60) };
  assert.equal(classifySync(row, LIVE,  { now: NOW }).status, 'stale');
  assert.equal(classifySync(row, LIVE,  { now: NOW }).ok, false);
  assert.equal(classifySync(row, DAILY, { now: NOW }).status, 'ok');
});

test('a daily-only pull is stale past ~26h', () => {
  const v = classifySync({ last_success_at: minsAgo(27 * 60) }, DAILY, { now: NOW });
  assert.equal(v.status, 'stale');
});

test('failing: the last run errored after the last success', () => {
  const v = classifySync(
    { last_success_at: minsAgo(90), last_error_at: minsAgo(5), last_error: 'Odoo mining report HTTP 502 from https://internal.example/x' },
    LIVE, { now: NOW });
  assert.equal(v.status, 'failing');
  assert.equal(v.ok, false);
});

test('recovered: an old error followed by a newer success is ok', () => {
  const v = classifySync(
    { last_success_at: minsAgo(5), last_error_at: minsAgo(90), last_error: 'boom' },
    LIVE, { now: NOW });
  assert.equal(v.status, 'ok');
  assert.equal(v.ok, true);
});

test('the verdict never carries raw error text — GET /api/health is public', () => {
  const secret = 'ECONNREFUSED 10.0.0.7:8069 /var/secret/path';
  const v = classifySync({ last_error_at: minsAgo(1), last_error: secret }, LIVE, { now: NOW, uptimeS: 99999 });
  assert.equal(v.status, 'failing');
  assert.ok(!JSON.stringify(v).includes(secret), 'raw upstream error leaked into the public health verdict');
  assert.ok(!('last_error' in v));
});

test('runOdooSync({ only }) with names that match nothing does no work at all', async () => {
  const r = await runOdooSync({ only: ['no-such-pull'] });
  assert.deepEqual(r.ran, []);
  assert.equal(r.skipped, 'no pulls configured');
});
