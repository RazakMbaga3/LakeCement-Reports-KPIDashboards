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

  The stores pull joined on 2026-10-01, for the same reason the production
  autofill did: the daily job is gated by ODOO_SYNC_CRON, which .env.example
  ships as `off`, so a droplet built from that file would never sync stores
  at all. Being on the switch that defaults to ON is what makes "is it
  pulling?" have one answer instead of two.

  It is the most expensive member of this list — ~33 s for a 7-day window
  (gate entries alone are ~15 s; see odooStoresClient.js for the
  per-endpoint timings) against an ERP that also serves the plant's own
  Odoo users. That is accepted deliberately: receipts and pending-GRN are
  what an officer reads while filling the Raw Material form during the day,
  and a figure that is up to 24 h stale is one they would have to go and
  check in Odoo anyway, which is the manual step this whole pipeline exists
  to remove. The three datasets run SEQUENTIALLY inside the pull, so it adds
  one request at a time rather than three at once.
*/

const LIVE_PULLS = Object.freeze([
  'dispatch-daily-summary',
  'mining-weighbridge-tickets',
  'production-report-autofill',
  'stores-gate-grn-issues',
]);

module.exports = { LIVE_PULLS };
