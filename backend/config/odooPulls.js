/*
  config/odooPulls.js — which Odoo pulls run on the frequent "live" schedule.

  This lives in config/, not in services/odooSync.js, for one reason: both
  odooSync.js (which runs the pulls) and health.js (which reports whether a
  pull is scheduled) need the same list, and importing it from one service
  into the other closes a cycle — health -> odooSync -> watchdog -> health.
  Node resolves that cycle by handing one of them a half-built module, so
  watchdog.js's `const { deepHealth } = require('./health')` would capture
  undefined and only fail later, at the first watchdog tick.

  Keeping the list in a leaf module nothing else imports means the two stay
  in step without the cycle. Before this file existed, health.js restated the
  names inline, and that copy was exactly what would have kept reporting
  `not_scheduled` for the production autofill after it joined the live job on
  2026-09-28.

  Membership is a cost question, not a correctness one — every pull is
  idempotent, so running one more often is safe and just costs a request.
  Measured against the production ERP on 2026-09-28: a 7-day production
  window is 4.5 s and 128 KB (107 entries).
*/

const LIVE_PULLS = Object.freeze([
  'dispatch-daily-summary',
  'mining-weighbridge-tickets',
  'production-report-autofill',
]);

module.exports = { LIVE_PULLS };
