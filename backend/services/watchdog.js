/*
  services/watchdog.js — operational alerting.

  Every run (WATCHDOG_CRON, default every 15 min; also POST
  /api/monitor/watchdog/run and `npm run watchdog`):

    • deep health not 'ok'      → 'health-degraded' / 'health-down'
    • disk below threshold      → included in health-degraded detail
    • backup stale/missing      → included in health-degraded detail
    • missed entries: after MISSED_ENTRY_CUTOFF (default 10:00), any form
      in MISSED_ENTRY_FORMS with no submission for the day
                                 → 'missed-entry:<form>'
    • correction windows that closed unused are SWEPT: the report is restored
      to the figures it held when the window was granted, so a half-typed
      correction can never become the permanent record. Not an alert by
      itself — but a window that had to REVERT someone's unsubmitted work is
      surfaced as 'amendment-expired:<form>', because a person lost progress
      and should hear about it (their typing is kept in report_revisions).

  Each alert fires ONCE per day per kind (deduped against the alerts
  table) and is emailed to ALERT_TO (falls back to DIGEST_TO) via the
  shared mailer. If the database itself is down, dedupe/recording are
  impossible — the email is still sent (that's the moment you most want
  it), so expect repeats until the DB returns.
*/

const db = require('../db');
const { REPORTED_STATUSES } = require('../config/forms');
const { deepHealth } = require('./health');
const { sweepExpired } = require('./reportAmendments');
const { sendMail } = require('./mailer');

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pastCutoff() {
  const [h, m] = (process.env.MISSED_ENTRY_CUTOFF || '10:00').split(':').map(Number);
  const now = new Date();
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= (m || 0));
}

async function missedEntries(date) {
  const watch = (process.env.MISSED_ENTRY_FORMS ||
    'production,quality,dispatch,power-cons,mines')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!watch.length || !pastCutoff()) return [];

  /* A saved DRAFT is not a submission — counting it as one would silence
     the very alert that exists to catch an entry nobody finished. Same
     REPORTED_STATUSES rule the KPI engine and the MIS pack use. */
  const rows = await db.query(
    'SELECT DISTINCT form_type FROM daily_reports WHERE record_date = $1 AND status = ANY($2)',
    [date, REPORTED_STATUSES]);
  const submitted = new Set(rows.rows.map(r => r.form_type));

  return watch.filter(f => !submitted.has(f)).map(f => ({
    kind: 'missed-entry:' + f,
    detail: `No ${f} submission for ${date} by the ${process.env.MISSED_ENTRY_CUTOFF || '10:00'} cutoff.`,
  }));
}

/* true if this kind already alerted today */
async function alreadyFired(kind) {
  const r = await db.query(
    `SELECT 1 FROM alerts WHERE kind = $1 AND created_at::date = CURRENT_DATE LIMIT 1`, [kind]);
  return !!r.rows[0];
}

function alertEmailHtml(alerts) {
  const items = alerts.map(a =>
    `<li style="margin:6px 0"><strong>${a.kind}</strong><br>
     <span style="color:#64748B;font-size:13px">${a.detail}</span></li>`).join('');
  return `
  <div style="font-family:Segoe UI,system-ui,sans-serif;max-width:640px;color:#173158">
    <div style="background:#DC2626;color:white;padding:12px 18px;border-radius:8px 8px 0 0;font-weight:800">
      ⚠ NYATI MIS — OPERATIONAL ALERT</div>
    <div style="border:1px solid #DDE3EC;border-top:none;padding:14px 18px;border-radius:0 0 8px 8px">
      <ul style="padding-left:18px;margin:0">${items}</ul>
      <p style="color:#94A3B8;font-size:11px;margin-top:12px">
        Sent by the MIS watchdog at ${new Date().toLocaleString('en-GB')}.
        Details: MIS → Monitor page.</p>
    </div>
  </div>`;
}

/* opts.date — override the day checked for missed entries (tests/backfill) */
async function runWatchdog(opts = {}) {
  const date = opts.date || localDateStr(new Date());
  const candidates = [];

  const health = await deepHealth().catch(err =>
    ({ status: 'down', checks: { error: err.message } }));
  if (health.status !== 'ok') {
    candidates.push({
      kind: 'health-' + health.status,
      detail: JSON.stringify(health.checks),
    });
  }

  const dbUp = health.status !== 'down';
  if (dbUp) {
    try { candidates.push(...await missedEntries(date)); }
    catch (err) { candidates.push({ kind: 'watchdog-error', detail: 'missed-entry check failed: ' + err.message }); }

    /* Its own try/catch, and after the missed-entry check: housekeeping
       failing must neither hide a health alert nor stop the next run from
       trying again. */
    try {
      const swept = await sweepExpired();
      for (const w of swept.filter(x => x.reverted)) {
        candidates.push({
          kind: 'amendment-expired:' + w.formType,
          detail: `Correction #${w.id} on the ${w.formType} report for ${String(w.date).slice(0, 10)} expired unused `
                + `(requested by ${w.requestedBy || 'unknown'}); unsubmitted changes were reverted and are kept in report_revisions.`,
        });
      }
    } catch (err) {
      candidates.push({ kind: 'watchdog-error', detail: 'correction-window sweep failed: ' + err.message });
    }
  }

  // Dedupe: one alert per kind per day (only possible while the DB is up)
  const fired = [], skipped = [];
  for (const a of candidates) {
    if (dbUp && await alreadyFired(a.kind).catch(() => false)) skipped.push(a.kind);
    else fired.push(a);
  }

  let email = { sent: false, reason: 'no alerts' };
  if (fired.length) {
    /* Deliberately no .catch. sendMail returns { sent:false, reason } for
       everything — not configured, no recipients, a 535 from the tenant —
       and never throws (services/mailer.js:39, covered by
       test/mailer.test.js). The .catch that used to be here turned
       err.message into `reason`, and routes/monitor.js:76 hands this whole
       object to res.json(): a raw transport error names internal Exchange
       hosts and tenant policy, and that would have gone to the browser.
       mailer.js's own reason is written to be safe to relay. If a throw
       ever does escape, it must surface as a 500 through the central error
       handler, not be quietly reshaped into a leaky success-shaped object. */
    email = await sendMail({
      subject: `⚠ Nyati MIS alert: ${fired.map(a => a.kind).join(', ')}`,
      html: alertEmailHtml(fired),
      to: process.env.ALERT_TO || process.env.DIGEST_TO,
    });

    if (dbUp) {
      for (const a of fired) {
        await db.query(
          'INSERT INTO alerts (kind, detail, emailed) VALUES ($1, $2, $3)',
          [a.kind, a.detail, !!email.sent]
        ).catch(() => { /* alert already emailed — recording is best-effort */ });
      }
    }
  }

  return { date, health: { status: health.status, checks: health.checks }, fired, skipped, email };
}

/* Fire a single alert immediately, outside the normal 15-min watchdog
   sweep — for a failure a background job (the Odoo sync) discovers in
   the moment rather than on the next periodic check. Same dedupe-once-
   per-kind-per-day and email-then-record semantics as runWatchdog()'s own
   candidates, so these show up identically on monitor.html. Previously
   Odoo sync failures only reached backend/logs/ (logger.warn/error) —
   unlike every other monitored condition, nothing ever emailed or
   recorded them, so a broken integration could go unnoticed indefinitely
   outside of someone actively reading logs. */
async function fireAlert(kind, detail) {
  if (await alreadyFired(kind).catch(() => false)) return { fired: false, skipped: true };

  const email = await sendMail({
    subject: `⚠ Nyati MIS alert: ${kind}`,
    html: alertEmailHtml([{ kind, detail }]),
    to: process.env.ALERT_TO || process.env.DIGEST_TO,
  }).catch(err => ({ sent: false, reason: err.message }));

  await db.query(
    'INSERT INTO alerts (kind, detail, emailed) VALUES ($1, $2, $3)',
    [kind, detail, !!email.sent]
  ).catch(() => { /* alert already emailed — recording is best-effort */ });

  return { fired: true, email };
}

module.exports = { runWatchdog, fireAlert };
