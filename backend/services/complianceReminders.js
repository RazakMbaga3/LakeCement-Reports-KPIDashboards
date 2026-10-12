/*
  services/complianceReminders.js — the daily reminder run.

  WHO IS TOLD, AND WHEN (stages from complianceStatus.computeStatus):
    D    lead day 1 reached  → the responsible person ("Level 1")
    S    lead day 2 reached  → + the supervisor ("Level 2")
    H    lead day 3 reached  → + the central Head list
    ODn  overdue             → all three; the day after the deadline, then
                               every 7 days (14 once a renewal is in progress)
  Defaults 45/30/20 days; each record's own lead days win.

  EXACTLY ONCE. Every reminder is a row in compliance_notifications keyed
  (item, deadline, stage, recipient). The run inserts what should exist and
  sends only rows that are new or released, so running it twice in a day —
  the cron runs at 07:00 and 14:00 — sends nothing twice. A renewal moves
  the deadline, so the next cycle starts from a fresh key on its own.

  WHAT IS HELD BACK, AND WHY IT IS STILL RECORDED:
    held_unverified    the record came from the workbook and its owner has
                       not confirmed it yet (decided 2026-10-12: import
                       honestly, hold reminders until verified — otherwise
                       day one mails ~100 people about stale dates);
    skipped_no_email   the person has no email address on file;
    skipped_disabled   reminders are switched off (globally — the master
                       switch starts OFF — or on that record).
  These rows are re-evaluated on every run, so verifying a record or adding
  an email releases the reminder that same day. Rows that no longer apply
  (the stage moved on, the deadline changed) become 'superseded'.

  FAILURES never throw (mailer.sendMail never does): a failed send is
  retried after 2 h, then 6 h, then given up, each attempt logged. With no
  mail route configured at all, rows wait as 'pending' instead of burning
  attempts, and go out on the first run after mail works.

  MEMORY (RAID I-32: pm2 restarts the app at 300 MB): one pass over ~200
  rows, no document bytes ever loaded, sends one at a time. Each run records
  its duration and heap delta. Nothing runs at boot.
*/
const db = require('../db');
const { sendMail, makeTransport } = require('./mailer');
const S = require('./complianceStatus');
const D = require('./complianceData');
const { composeReminder, SYSTEM } = require('./complianceMail');

const OPEN_STATUSES = ['pending', 'failed', 'held_unverified', 'skipped_no_email', 'skipped_disabled'];
const RETRY_AFTER_MS = [2 * 3600e3, 6 * 3600e3];
const MAX_ATTEMPTS = 3;

async function loadHeadList(q) {
  const { rows } = await q.query(
    `SELECT h.contact_id, h.label, c.name, COALESCE(NULLIF(u.email, ''), c.email) AS email
       FROM compliance_head_recipients h
       JOIN compliance_contacts c ON c.id = h.contact_id AND c.active
       LEFT JOIN users u ON u.id = c.user_id AND u.active
      ORDER BY h.position, c.name`);
  return rows.map(r => ({ contactId: r.contact_id, name: r.name, email: r.email || null, label: r.label }));
}

/* HOD accounts per role — the fallback when a record names no responsible
   person, so an unowned obligation still reaches its department. */
async function loadHods(q) {
  const { rows } = await q.query(
    `SELECT id, role, full_name, email FROM users
      WHERE active AND level = 'hod' AND email IS NOT NULL AND email <> ''`);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.role)) m.set(r.role, []);
    m.get(r.role).push({ userId: r.id, name: r.full_name, email: r.email });
  }
  return m;
}

function recipientsFor(item, audience, ctx) {
  if (audience === 'head') return ctx.heads.map(h => ({ key: `c:${h.contactId}`, name: h.name, email: h.email }));
  const list = audience === 'direct' ? item.direct : item.second;
  const active = list.filter(p => p.active !== false);
  if (active.length) return active.map(p => ({ key: `c:${p.contactId}`, name: p.name, email: p.email }));
  if (audience === 'direct' && ctx.settings.hod_fallback !== false) {
    return (ctx.hods.get(item.owner_role) || []).map(h => ({ key: `u:${h.userId}`, name: h.name, email: h.email, fallback: true }));
  }
  return [];
}

/* Pure: the notification rows that SHOULD exist as of now, each with the
   status it should have. */
function planReminders(items, ctx) {
  const out = [];
  for (const it of items) {
    const c = it.computed;
    if (!c || !c.stage || !c.deadline) continue;
    const seen = new Set();
    for (const audience of S.audiencesFor(c.stage)) {
      for (const r of recipientsFor(it, audience, ctx)) {
        if (seen.has(r.key)) continue;     // the same person as direct and supervisor gets one row
        seen.add(r.key);
        let status = 'pending';
        if (!ctx.globalEnabled || !it.reminders_enabled) status = 'skipped_disabled';
        else if (!it.verified_at) status = 'held_unverified';
        else if (!r.email) status = 'skipped_no_email';
        out.push({
          item_id: it.id, deadline: c.deadline, stage: c.stage, audience,
          recipient_key: r.key, recipient_name: r.name || null, recipient_email: r.email || null, status,
        });
      }
    }
  }
  return out;
}

const keyOf = r => `${r.item_id}|${r.deadline}|${r.stage}|${r.recipient_key}`;

function entryFor(it, audience) {
  const c = it.computed;
  return {
    id: it.id, title: it.title, kind: it.kind, department: it.departmentLabel, agency: it.agency,
    reference_no: it.reference_no, deadline: c.deadline, days_left: c.daysLeft, status: c.status,
    condition_result: it.condition_result, renewal_in_progress: it.renewal_in_progress,
    renewal_note: it.renewal_note, audience,
  };
}

/* Load + decorate every item. In a real run the recurring periods are
   rolled forward in the database first; a dry run simulates them in memory
   so a preview "as of" a future date sees the instances that would exist. */
async function prepare(q, today, settings, { persist }) {
  const items = await D.loadItems(q, {});
  if (persist) {
    const added = await D.ensurePeriods(q, items, today, settings);
    D.decorate(items, today, settings);
    await D.refreshNextDue(q, items);
    await D.writeSnapshot(q, items, today);
    return { items, periodsAdded: added };
  }
  D.simulatePeriods(items, today, settings);
  D.decorate(items, today, settings);
  return { items, periodsAdded: 0 };
}

let running = false;

async function runReminders({ dryRun = false, trigger = 'manual', asOf = null } = {}) {
  if (running) return { ok: false, skipped: true, reason: 'a reminder run is already in progress' };
  running = true;
  const t0 = Date.now();
  const heap0 = process.memoryUsage().heapUsed;
  const today = S.isDate(asOf) ? asOf : S.todayIn();
  let runId = null;
  try {
    runId = (await db.query(
      `INSERT INTO compliance_reminder_runs (as_of, trigger, dry_run) VALUES ($1,$2,$3) RETURNING id`,
      [today, trigger === 'cron' ? 'cron' : 'manual', !!dryRun])).rows[0].id;

    const settings = await D.loadSettings(db);
    const globalEnabled = settings.reminders_enabled === true;
    let prepared;
    if (dryRun) prepared = await prepare(db, today, settings, { persist: false });
    else prepared = await db.withTransaction(client => prepare(client, today, settings, { persist: true }));
    const { items, periodsAdded } = prepared;
    const byId = new Map(items.map(i => [i.id, i]));
    const ctx = { heads: await loadHeadList(db), hods: await loadHods(db), settings, globalEnabled };
    const desired = planReminders(items, ctx);

    const stats = {
      asOf: today, items: items.length, periodsAdded, remindersEnabled: globalEnabled,
      planned: desired.length, byStatus: {}, created: 0, released: 0, superseded: 0,
      emailsAttempted: 0, emailsSent: 0, emailsFailed: 0, waitingForMailRoute: 0,
    };
    for (const d of desired) stats.byStatus[d.status] = (stats.byStatus[d.status] || 0) + 1;

    const { rows: existing } = await db.query(
      `SELECT id, item_id, deadline, stage, recipient_key, status, attempts, next_attempt_at FROM compliance_notifications
        WHERE status <> 'superseded'`);
    const existingByKey = new Map(existing.map(r => [keyOf(r), r]));

    if (dryRun) {
      const wouldSend = desired.filter(d => d.status === 'pending' && !(existingByKey.get(keyOf(d)) && ['sent', 'gave_up'].includes(existingByKey.get(keyOf(d)).status)));
      const groups = {};
      for (const d of wouldSend) {
        const k = d.recipient_email.toLowerCase();
        groups[k] = groups[k] || { email: d.recipient_email, name: d.recipient_name, items: [] };
        const it = byId.get(d.item_id);
        groups[k].items.push({ id: d.item_id, title: it.title, stage: d.stage, audience: d.audience, deadline: d.deadline });
      }
      stats.wouldEmail = Object.keys(groups).length;
      const held = desired.filter(d => d.status !== 'pending').map(d => ({ item_id: d.item_id, title: byId.get(d.item_id).title,
        stage: d.stage, audience: d.audience, recipient: d.recipient_name, status: d.status }));
      return finish(runId, t0, heap0, stats, { preview: Object.values(groups), held: held.slice(0, 300) });
    }

    // 1. Insert what should exist; release rows whose reason has gone.
    const desiredKeys = new Set();
    for (const d of desired) {
      const k = keyOf(d);
      desiredKeys.add(k);
      const ex = existingByKey.get(k);
      if (!ex) {
        const r = await db.query(
          `INSERT INTO compliance_notifications (item_id, deadline, stage, audience, recipient_key, recipient_name, recipient_email, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (item_id, deadline, stage, recipient_key) DO NOTHING RETURNING id`,
          [d.item_id, d.deadline, d.stage, d.audience, d.recipient_key, d.recipient_name, d.recipient_email, d.status]);
        if (r.rows.length) stats.created++;
        continue;
      }
      const reevaluable = ['held_unverified', 'skipped_no_email', 'skipped_disabled'].includes(ex.status);
      const retryDue = ex.status === 'failed' && (!ex.next_attempt_at || new Date(ex.next_attempt_at) <= new Date());
      if ((reevaluable && ex.status !== d.status) || (retryDue && d.status === 'pending')) {
        await db.query(
          `UPDATE compliance_notifications SET status = $2, recipient_email = $3, recipient_name = $4, updated_at = NOW() WHERE id = $1`,
          [ex.id, d.status, d.recipient_email, d.recipient_name]);
        if (d.status === 'pending') stats.released++;
      } else if (ex.status === 'failed' && d.status !== 'pending') {
        await db.query(`UPDATE compliance_notifications SET status = $2, updated_at = NOW() WHERE id = $1`, [ex.id, d.status]);
      }
    }

    // 2. Rows that no longer apply.
    const stale = existing.filter(r => OPEN_STATUSES.includes(r.status) && !desiredKeys.has(keyOf(r))).map(r => r.id);
    if (stale.length) {
      await db.query(`UPDATE compliance_notifications SET status = 'superseded', updated_at = NOW() WHERE id = ANY($1)`, [stale]);
      stats.superseded = stale.length;
    }

    // 3. Send everything pending, one consolidated email per address.
    const { rows: pending } = await db.query(
      `SELECT id, item_id, audience, recipient_name, recipient_email, attempts FROM compliance_notifications
        WHERE status = 'pending' AND recipient_email IS NOT NULL ORDER BY id`);
    const groups = new Map();
    for (const p of pending) {
      const it = byId.get(p.item_id);
      if (!it) continue;
      const k = p.recipient_email.toLowerCase();
      if (!groups.has(k)) groups.set(k, { email: p.recipient_email, name: p.recipient_name, rows: [], entries: new Map() });
      const g = groups.get(k);
      g.rows.push(p);
      // One line per item even if the person is on it twice (direct + head).
      if (!g.entries.has(p.item_id)) g.entries.set(p.item_id, entryFor(it, p.audience));
    }
    if (groups.size && !makeTransport()) {
      stats.waitingForMailRoute = pending.length;
      await db.query(`UPDATE compliance_notifications SET last_error = 'mail not configured', updated_at = NOW() WHERE status = 'pending'`);
    } else {
      for (const g of groups.values()) {
        const { subject, html } = composeReminder({ recipientName: g.name, entries: [...g.entries.values()] });
        stats.emailsAttempted++;
        const res = await sendMail({ to: g.email, subject, html, fromName: SYSTEM });
        const log = await db.query(
          `INSERT INTO compliance_mail_log (run_id, recipient_email, subject, item_count, sent, reason, transport)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [runId, g.email, subject.slice(0, 250), g.entries.size, !!res.sent, res.sent ? null : String(res.reason || '').slice(0, 200), res.transport || null]);
        const ids = g.rows.map(r => r.id);
        if (res.sent) {
          stats.emailsSent++;
          await db.query(
            `UPDATE compliance_notifications SET status = 'sent', sent_at = NOW(), attempts = attempts + 1,
                    mail_log_id = $2, last_error = NULL, updated_at = NOW() WHERE id = ANY($1)`, [ids, log.rows[0].id]);
        } else {
          stats.emailsFailed++;
          const attempts = Math.max(...g.rows.map(r => r.attempts)) + 1;
          const giveUp = attempts >= MAX_ATTEMPTS;
          await db.query(
            `UPDATE compliance_notifications SET status = $2, attempts = attempts + 1, last_error = $3, mail_log_id = $4,
                    next_attempt_at = $5, updated_at = NOW() WHERE id = ANY($1)`,
            [ids, giveUp ? 'gave_up' : 'failed', String(res.reason || 'send failed').slice(0, 200), log.rows[0].id,
              giveUp ? null : new Date(Date.now() + RETRY_AFTER_MS[Math.min(attempts - 1, RETRY_AFTER_MS.length - 1)])]);
        }
      }
    }
    return finish(runId, t0, heap0, stats);
  } catch (err) {
    if (runId) {
      await db.query(`UPDATE compliance_reminder_runs SET finished_at = NOW(), ok = false, error = $2, duration_ms = $3 WHERE id = $1`,
        [runId, String(err.message || err).slice(0, 500), Date.now() - t0]).catch(() => {});
    }
    throw err;
  } finally {
    running = false;
  }
}

async function finish(runId, t0, heap0, stats, extra) {
  const duration = Date.now() - t0;
  const heapDeltaKb = Math.round((process.memoryUsage().heapUsed - heap0) / 1024);
  await db.query(
    `UPDATE compliance_reminder_runs SET finished_at = NOW(), ok = true, stats = $2, duration_ms = $3, heap_delta_kb = $4 WHERE id = $1`,
    [runId, JSON.stringify(stats), duration, heapDeltaKb]);
  return Object.assign({ ok: true, runId, durationMs: duration, heapDeltaKb, stats }, extra || {});
}

module.exports = { runReminders, planReminders, recipientsFor, loadHeadList };
