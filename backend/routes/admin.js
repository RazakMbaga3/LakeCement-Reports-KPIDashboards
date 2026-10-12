/*
  routes/admin.js — user provisioning for the admin screen (admin-users.html),
  so adding a person or changing their access no longer means editing
  db/seed.js and running a script.

  Every route is admin-only. That is deliberately narrower than
  PERMISSIONS[role].canManageUsers suggests it could be: creating accounts
  and moving people between levels is the one action that can grant every
  other action, so it stays with the single role that already holds
  break-glass rights rather than spreading to HR or department heads. When
  the business wants HR to raise requests, that is an approval queue on top
  of this — not a widening of it.

  RULES ENFORCED HERE (beyond the schema's own constraints):
    • No hard delete. users.id is referenced by audit_log, report_approvals,
      kpi_overrides, kpi_submissions, weighbridge_tickets and sales_targets;
      deleting a row would orphan the history those tables exist to keep.
      Deactivation is the only removal.
    • No self-modification of role, level or active. An administrator may
      not quietly promote themselves, and may not lock themselves out
      either — both are separation-of-duties failures and the second is an
      easy way to end up with no working admin account at all.
    • username is immutable. It is the access key every rule is written
      against and the anchor of every audit_log row already written; a
      rename would silently reattribute history.
    • Any change to role, level or active bumps token_version, so an
      already-signed-in user picks the change up on their next request
      instead of keeping their old rights for up to 8 hours.
*/
const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { ROLES, LEVELS, DEPARTMENTS, ROLE_KEYS, LEVEL_KEYS } = require('../config/orgCatalogue');
const authTokens = require('../services/authTokens');
const authMail   = require('../services/authMail');
const { mailConfigured } = require('../services/mailer');
const {
  FORM_ACCESS, KPI_EDIT_DEPTS, COMMERCIAL_VIEW_ROLES, PURCHASE_VIEW_ROLES, MIS_VIEW_ROLES,
} = require('../../forms/access-registry.js');

const router = express.Router();
const SALT_ROUNDS = 12;

const adminOnly = [requireAuth, requireRole('admin')];

/* Columns the UI is allowed to see. password_hash is never in this list —
   not even to say whether one is set; must_change_password answers that. */
const USER_FIELDS = `
  id, username, full_name, email, phone, staff_no, role, department, level,
  active, must_change_password, email_verified, last_login, created_at,
  failed_attempts, locked_until`;

function genPassword() {
  // 12 bytes -> 16 url-safe chars. Temporary by construction: every account
  // created or reset here carries must_change_password, so this value only
  // has to survive one login.
  return crypto.randomBytes(12).toString('base64url');
}

async function audit(client, req, action, target, details) {
  await client.query(
    `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user.id, req.user.username, action, target, String(details).slice(0, 4000), req.ip]
  );
}

/* Postgres surfaces both uniqueness rules as 23505. Translating them here
   keeps the UI from having to parse a driver error, and says which field
   the user needs to fix. */
function uniqueViolation(err) {
  if (err && err.code === '23505') {
    if (String(err.constraint).includes('email')) return 'That email address is already on another account.';
    if (String(err.constraint).includes('username')) return 'That username is already taken.';
    return 'That value is already in use on another account.';
  }
  if (err && err.code === '23514' && String(err.constraint).includes('email_shape')) {
    return 'That email address is not a valid address.';
  }
  return null;
}

/* ── Catalogue — what the pickers offer, and what each role/level grants ──
   Served rather than duplicated in the page so the admin screen cannot
   drift from the registry the gates actually read. */
router.get('/catalogue', ...adminOnly, (req, res) => {
  res.json({
    roles: ROLES.map(r => ({
      ...r,
      // A plain-language summary of what choosing this role will grant.
      grants: {
        submitsForms:   FORM_ACCESS[r.role] || [],
        kpiEditDepts:   KPI_EDIT_DEPTS[r.role] === 'all' ? 'all' : (KPI_EDIT_DEPTS[r.role] || []),
        seesSales:      COMMERCIAL_VIEW_ROLES.includes(r.role),
        seesPurchases:  PURCHASE_VIEW_ROLES.includes(r.role),
        seesMIS:        MIS_VIEW_ROLES.includes(r.role),
      },
    })),
    levels: LEVELS,
    departments: DEPARTMENTS,
  });
});

/* ── List ────────────────────────────────────────────────────────────── */
const listQuery = z.object({
  q:          z.string().trim().max(80).optional(),
  department: z.string().trim().max(50).optional(),
  level:      z.enum(LEVEL_KEYS).optional(),
  status:     z.enum(['active', 'inactive', 'all']).optional(),
});

router.get('/users', ...adminOnly, validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { q, department, level, status } = req.validated.query;
    const params = [];
    const where  = [];

    if (q) {
      params.push('%' + q.toLowerCase() + '%');
      where.push(`(LOWER(username) LIKE $${params.length} OR LOWER(full_name) LIKE $${params.length} OR LOWER(COALESCE(email,'')) LIKE $${params.length})`);
    }
    if (department) { params.push(department); where.push(`department = $${params.length}`); }
    if (level)      { params.push(level);      where.push(`level = $${params.length}`); }
    if (status === 'active')   where.push('active = true');
    if (status === 'inactive') where.push('active = false');

    const { rows } = await db.query(
      `SELECT ${USER_FIELDS} FROM users
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY department, CASE level WHEN 'hod' THEN 1 WHEN 'senior' THEN 2 ELSE 3 END, username`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── Create ──────────────────────────────────────────────────────────── */
const createBody = z.object({
  username:   z.string().trim().toLowerCase().min(3).max(50)
                .regex(/^[a-z0-9_.-]+$/, 'Letters, digits, dot, dash and underscore only'),
  full_name:  z.string().trim().min(2).max(100),
  role:       z.enum(ROLE_KEYS),
  level:      z.enum(LEVEL_KEYS),
  department: z.string().trim().min(2).max(50),
  email:      z.string().trim().email('Enter a valid email address').max(120).optional().or(z.literal('')),
  phone:      z.string().trim().max(30).optional().or(z.literal('')),
  staff_no:   z.string().trim().max(30).optional().or(z.literal('')),
});

router.post('/users', ...adminOnly, validate(createBody, 'body'), async (req, res, next) => {
  try {
    const b = req.validated.body;
    const password = genPassword();
    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    const row = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (username, password_hash, full_name, role, department, level,
                            email, phone, staff_no, active, must_change_password, email_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,true,false)
         RETURNING ${USER_FIELDS}`,
        [b.username, hash, b.full_name, b.role, b.department, b.level,
         b.email || null, b.phone || null, b.staff_no || null]
      );
      await audit(client, req, 'USER_CREATE', b.username,
        `${b.full_name} — ${b.role}/${b.level} in ${b.department}${b.email ? ', ' + b.email : ', no email'}`);
      return rows[0];
    });

    /* The password is returned exactly once and never stored in readable
       form. The admin has to hand it over now; there is no "show it again"
       — only a reset, which is itself audited. */
    res.status(201).json({ user: row, temporaryPassword: password });
  } catch (err) {
    const msg = uniqueViolation(err);
    if (msg) return res.status(409).json({ error: msg });
    next(err);
  }
});

/* ── Update ──────────────────────────────────────────────────────────── */
const updateBody = z.object({
  full_name:  z.string().trim().min(2).max(100).optional(),
  role:       z.enum(ROLE_KEYS).optional(),
  level:      z.enum(LEVEL_KEYS).optional(),
  department: z.string().trim().min(2).max(50).optional(),
  email:      z.string().trim().email('Enter a valid email address').max(120).nullable().optional().or(z.literal('')),
  phone:      z.string().trim().max(30).nullable().optional().or(z.literal('')),
  staff_no:   z.string().trim().max(30).nullable().optional().or(z.literal('')),
  active:     z.boolean().optional(),
}).refine(o => Object.keys(o).length > 0, 'Nothing to update');

const idParam = z.object({ id: z.coerce.number().int().positive() });

// Changing any of these alters what the account can DO, so outstanding
// tokens must stop being trusted.
const ACCESS_FIELDS = ['role', 'level', 'active'];
const ACCESS_FIELD_LABELS = { role: 'role', level: 'access level', active: 'active/inactive status' };

router.patch('/users/:id', ...adminOnly,
  validate(idParam, 'params'), validate(updateBody, 'body'),
  async (req, res, next) => {
    try {
      const { id } = req.validated.params;
      const patch  = req.validated.body;

      const { rows: [before] } = await db.query(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [id]);
      if (!before) return res.status(404).json({ error: 'No such user.' });

      const touchesAccess = ACCESS_FIELDS.filter(f => f in patch && patch[f] !== before[f]);

      if (id === req.user.id && touchesAccess.length) {
        return res.status(403).json({
          error: `You cannot change your own ${touchesAccess.map(f => ACCESS_FIELD_LABELS[f]).join(' or ')}. Ask another administrator — this is what stops an admin from quietly promoting themselves, and stops the last working admin account being locked out by accident.`,
        });
      }

      // Blank strings from the form mean "clear this optional field".
      const sets = [], params = [];
      for (const [k, v] of Object.entries(patch)) {
        params.push(v === '' ? null : v);
        sets.push(`${k} = $${params.length}`);
      }
      if (touchesAccess.length) sets.push('token_version = token_version + 1');
      params.push(id);

      const row = await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${USER_FIELDS}`, params);

        const diff = Object.keys(patch)
          .filter(k => String(before[k] ?? '') !== String(rows[0][k] ?? ''))
          .map(k => `${k}: ${before[k] ?? '—'} -> ${rows[0][k] ?? '—'}`);
        if (diff.length) {
          await audit(client, req, 'USER_UPDATE', before.username,
            diff.join('; ') + (touchesAccess.length ? ' [sessions revoked]' : ''));
        }
        return rows[0];
      });

      res.json({ user: row, sessionsRevoked: touchesAccess.length > 0 });
    } catch (err) {
      const msg = uniqueViolation(err);
      if (msg) return res.status(409).json({ error: msg });
      next(err);
    }
  });

/* ── Password reset ──────────────────────────────────────────────────── */
/* Issues a fresh temporary password, forces a change at next login, and
   revokes outstanding tokens. Also clears the lockout counters, so this
   doubles as the way out of "locked after 5 bad attempts" — the situation
   an admin is most often called about. */
router.post('/users/:id/reset-password', ...adminOnly, validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.validated.params;
      const { rows: [target] } = await db.query('SELECT username, full_name FROM users WHERE id = $1', [id]);
      if (!target) return res.status(404).json({ error: 'No such user.' });

      const password = genPassword();
      const hash = await bcrypt.hash(password, SALT_ROUNDS);

      await db.withTransaction(async (client) => {
        await client.query(
          `UPDATE users SET password_hash = $2, must_change_password = true,
                            failed_attempts = 0, locked_until = NULL,
                            token_version = token_version + 1
            WHERE id = $1`, [id, hash]);
        await audit(client, req, 'USER_PASSWORD_RESET', target.username,
          `temporary password issued for ${target.full_name}; sessions revoked, lockout cleared`);
      });

      res.json({ ok: true, username: target.username, temporaryPassword: password });
    } catch (err) { next(err); }
  });

/* ── Unlock ──────────────────────────────────────────────────────────── */
/* Clears a lockout without changing the password — for the user who simply
   mistyped five times and still knows their own password. Kept separate
   from reset so the routine case does not force a password handover. */
router.post('/users/:id/unlock', ...adminOnly, validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.validated.params;
      const { rows: [target] } = await db.query('SELECT username FROM users WHERE id = $1', [id]);
      if (!target) return res.status(404).json({ error: 'No such user.' });

      await db.withTransaction(async (client) => {
        await client.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);
        await audit(client, req, 'USER_UNLOCK', target.username, 'lockout cleared by administrator');
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

/* ══════════════════════════════════════════════════════════════════════
   INVITATIONS — the replacement for reading a temporary password aloud.

   Handing a password over verbally does not scale (37 accounts are still on
   the ones committed in db/seed.js) and puts the secret through whoever is
   in earshot. An invite mails a single-use link instead; the password the
   user chooses is never known to anyone, including the administrator who
   created the account.
══════════════════════════════════════════════════════════════════════ */

/* Thrown when the token was issued but the mail did not go out. It exists
   to force the caller's transaction to roll back — see attemptInvite. */
class InviteNotSent extends Error {
  constructor(reason) {
    super(`invitation not sent: ${reason}`);
    this.name = 'InviteNotSent';
    this.reason = reason;
  }
}

/* Issues the invite and sends it, both inside the caller's transaction.

   The send is deliberately inside it, and a failure deliberately throws.
   authTokens.issue() supersedes this person's previous live invite
   (services/authTokens.js:46 — `UPDATE auth_tokens SET used_at = NOW()`),
   so the link already sitting in their inbox is dead the instant that
   UPDATE commits. Letting the transaction commit after a failed send would
   destroy a working link and put nothing in its place, while the admin sees
   only a 502 that doesn't mention it — worst of both. Rolling back restores
   the old token untouched, so a resend that fails costs the user nothing.

   That used to happen by accident: sendMail threw on a transport error and
   the throw rolled the transaction back. Commit 1617e2f made it return
   { sent:false } instead (rightly — the throw was an enumeration oracle on
   forgot-password, RAID R-7), which silently switched this rollback off.
   Hence the explicit throw.

   The mail hop therefore runs with a pool connection held open. That is the
   price of the rollback and it is bounded, not unbounded: mailer.js:27-29
   caps connect/greeting/socket at 10/10/30s precisely because of this
   transaction. If invites ever move to a queue, the send leaves the
   transaction and this note goes with it. */
async function inviteOne(client, req, user) {
  const token = await authTokens.issue(
    { userId: user.id, email: user.email, purpose: 'invite', createdBy: req.user.id }, client);
  const mail = await authMail.sendInvite({
    to: user.email, fullName: user.full_name, username: user.username, token,
  });
  if (!mail.sent) throw new InviteNotSent(mail.reason);
  await audit(client, req, 'USER_INVITED', user.username, `invitation sent to ${user.email}`);
  return mail;
}

/* One invite, in its own transaction, reported as { sent, reason } rather
   than as an exception — the shape both callers below already branch on.

   USER_INVITE_FAILED is written AFTER the rollback, on the pool rather than
   the rolled-back client: an audit row written inside that transaction
   would be undone along with the token, leaving no trace that anyone tried.
   Anything that isn't a send failure still propagates to the central error
   handler. */
async function attemptInvite(req, user) {
  try {
    return await db.withTransaction(client => inviteOne(client, req, user));
  } catch (err) {
    if (!(err instanceof InviteNotSent)) throw err;
    await audit(db, req, 'USER_INVITE_FAILED', user.username,
      `invitation NOT sent: ${err.reason}; token issue rolled back, any previous link still valid`);
    return { sent: false, reason: err.reason };
  }
}

/* Invite one person. Also the "resend" — issue() supersedes their previous
   outstanding invite, so an older link in an inbox stops working (unless
   the send fails, in which case the whole thing is rolled back). */
router.post('/users/:id/invite', ...adminOnly, validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.validated.params;
      const { rows: [u] } = await db.query(
        'SELECT id, username, full_name, email, active FROM users WHERE id = $1', [id]);
      if (!u)        return res.status(404).json({ error: 'No such user.' });
      if (!u.email)  return res.status(400).json({ error: `${u.full_name} has no email address. Add one before sending an invitation.` });
      if (!u.active) return res.status(400).json({ error: `${u.full_name}'s account is inactive. Reactivate it before inviting them.` });

      const mail = await attemptInvite(req, u);
      if (!mail.sent) {
        /* 502, not 500: the request was valid and nothing about the account
           is wrong — what failed is the mail hop. The admin needs to know
           the invite did NOT go out, because from their side the account
           already exists, and needs to know that any link this person was
           already holding still works, so they don't chase a problem that
           isn't there. */
        return res.status(502).json({
          error: `The account is fine, but the invitation could not be sent: ${mail.reason}. Any invitation link they already have still works. Fix the mail settings and send it again.`,
        });
      }
      res.json({ ok: true, sentTo: u.email });
    } catch (err) { next(err); }
  });

/* Bulk invite — the way out of "37 accounts on a password published in
   git". Scoped by an explicit filter rather than defaulting to everyone,
   and it skips anyone without an address instead of failing the batch.

   Not transactional across the whole run on purpose: mailing 37 people is
   not an atomic operation, and one bad address must not roll back the
   thirty-six that were delivered. Each invite is its own transaction and
   the response reports per-person outcomes. */
const bulkBody = z.object({
  department:       z.string().trim().max(50).optional(),
  onlyUnactivated:  z.boolean().optional(),   // still on a seeded password
});

router.post('/users/invite-bulk', ...adminOnly, validate(bulkBody, 'body'),
  async (req, res, next) => {
    try {
      const { department, onlyUnactivated } = req.validated.body;
      const params = [];
      const where = ['active = true', 'email IS NOT NULL', "department <> 'AUTOMATION'"];
      if (department)      { params.push(department); where.push(`department = $${params.length}`); }
      if (onlyUnactivated) { where.push('must_change_password = true'); }

      const { rows: targets } = await db.query(
        `SELECT id, username, full_name, email FROM users WHERE ${where.join(' AND ')} ORDER BY department, username`,
        params);

      const results = [];
      for (const u of targets) {
        try {
          const mail = await attemptInvite(req, u);
          results.push({ username: u.username, email: u.email, sent: mail.sent, reason: mail.reason });
        } catch (e) {
          results.push({ username: u.username, email: u.email, sent: false, reason: e.message });
        }
      }

      const sent = results.filter(r => r.sent).length;
      res.json({ ok: true, attempted: results.length, sent, failed: results.length - sent, results });
    } catch (err) { next(err); }
  });

/* Who could not be invited, and why — so an admin can see the work left
   before running a bulk send, rather than discovering it in the results. */
router.get('/invite-readiness', ...adminOnly, async (req, res, next) => {
  try {
    const { rows: [counts] } = await db.query(`
      SELECT
        count(*) FILTER (WHERE active AND department <> 'AUTOMATION')::int                        AS accounts,
        count(*) FILTER (WHERE active AND department <> 'AUTOMATION' AND email IS NULL)::int      AS no_email,
        count(*) FILTER (WHERE active AND department <> 'AUTOMATION' AND must_change_password)::int AS never_activated,
        count(*) FILTER (WHERE active AND department <> 'AUTOMATION' AND email_verified)::int     AS verified
      FROM users`);
    res.json({ ...counts, mailConfigured: mailConfigured(), appUrl: authMail.appUrl() });
  } catch (err) { next(err); }
});

module.exports = router;
