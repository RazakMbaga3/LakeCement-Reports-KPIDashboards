/*
  test/compliance-health.test.js — the reminder job's verdict on
  GET /api/health (services/health.js classifyComplianceRun), a pure
  function, so every edge is checked without a clock or a database query.
  Usage: node --test test/compliance-health.test.js
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyComplianceRun } = require('../services/health');

const NOW = Date.UTC(2026, 9, 12, 12, 0);
const h = n => new Date(NOW - n * 3600e3).toISOString();
const at = (row, opts = {}) => classifyComplianceRun(row, { scheduled: opts.scheduled !== false }, { now: NOW, uptimeS: opts.uptimeS ?? 30 * 3600 });

test('cron switched off is not ok', () => {
  assert.deepEqual([at(null, { scheduled: false }).ok, at(null, { scheduled: false }).status], [false, 'not_scheduled']);
});
test('no run yet: starting during the first 26 h, never_run after', () => {
  assert.deepEqual([at({}, { uptimeS: 3600 }).ok, at({}, { uptimeS: 3600 }).status], [true, 'starting']);
  assert.equal(at({}).status, 'never_run');
});
test('a recent success is ok; older than 26 h is stale', () => {
  assert.equal(at({ last_success_at: h(5) }).status, 'ok');
  assert.equal(at({ last_success_at: h(27) }).status, 'stale');
});
test('a failure newer than the last success is failing; an older one is history', () => {
  assert.equal(at({ last_success_at: h(10), last_error_at: h(2) }).status, 'failing');
  assert.equal(at({ last_success_at: h(2), last_error_at: h(10) }).status, 'ok');
});
