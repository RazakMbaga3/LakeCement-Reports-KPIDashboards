/*
  scripts/provision-hod-accounts.js — attaches real people (name, company
  email, phone, staff no.) to the existing L1/HOD department accounts.

  WHY IT UPDATES RATHER THAN CREATES
  Each department already has exactly one `level='hod'` row carrying the
  right role, department and access rights, and that row's id is referenced
  by audit_log, report_approvals, kpi_overrides, weighbridge_tickets and
  sales_targets. Creating a parallel per-person account would orphan that
  history and duplicate the access rules; renaming the existing row keeps
  both. `username` deliberately stays the role key ('ei', 'production', …)
  — every access rule in the codebase is written against role + level, and
  migration 012 added email ALONGSIDE username, not instead of it.

  WHAT IT DOES NOT TOUCH
  - password_hash / must_change_password: untouched, so an account still on
    its seeded default still forces a password change at first login, and
    one whose holder has already chosen a password keeps it.
  - role, level, active: untouched. This script gives an account a face; it
    never grants or widens access.
  The single exception is `department`, and only for the stale 'MINING'
  label on the Quarry HOD (its officer and senior already read 'QUARRY',
  so the HOD was the odd one out and Quarry rendered as having no HOD).

  Usage:
    node scripts/provision-hod-accounts.js              # dry run, prints the diff
    node scripts/provision-hod-accounts.js --apply      # writes
*/
require('../config/env');
const db = require('../db');

/* Roster confirmed 2026-09-03. `username` is the existing account the
   person takes over; it is never created here — if it is missing, that is
   a real inconsistency and the script says so instead of inserting.

   TWO PEOPLE WEAR TWO HATS, and the model cannot yet express that:
   `role` is single-valued (one department per account) and the email index
   is deliberately one-account-per-person, so neither can hold a second
   login. Both are parked on their DEPARTMENT account, which means neither
   currently has the cross-department oversight their group title implies:
     Sajiv Kumar  — General Manager, and Purchase/Procurement HOD → 'purchase_hod'
     IPN Pathak   — Strategic Business Head, and Sales & Marketing HOD → 'sales'
   Raised with the business 2026-09-03; do not "fix" this by minting a
   second account on a variant address. */
const ROSTER = [
  // ── Department HODs ────────────────────────────────────────────────
  { username: 'ei',           email: 'lokesh.thota@lakecement.co.tz',          full_name: 'Lokesh Thota' },
  { username: 'mining',       email: 'mukesh.agarwal@lakecement.co.tz',        full_name: 'Mukesh Agarwal',        department: 'QUARRY' },
  { username: 'packing',      email: 'jatinder.dogra@lakecement.co.tz',        full_name: 'Jatinder Dogra' },
  { username: 'cpp',          email: 'anbarasan.raman@lakecement.co.tz',       full_name: 'Anbarasan Raman' },
  { username: 'hr',           email: 'sophia.mkassi@lakecement.co.tz',         full_name: 'Sophia Mkassi' },
  { username: 'logistics',    email: 'pradeep.kumar@lakecement.co.tz',         full_name: 'Pradeep Kumar' },
  { username: 'it',           email: 'saurabh.bhattacharya@lakecement.co.tz',  full_name: 'Saurabh Bhattacharya' },
  { username: 'production',   email: 'godhania.natha@lakecement.co.tz',        full_name: 'Godhania Natha' },
  { username: 'stores',       email: 'kishor.jadav@lakecement.co.tz',          full_name: 'Kishor Jadav' },
  { username: 'finance',      email: 'muneesh.kumar@lakecement.co.tz',         full_name: 'Muneesh Kumar' },

  // ── Corporate / group management ───────────────────────────────────
  { username: 'planthead',    email: 'pavan.gandhi@lakecement.co.tz',          full_name: 'Pavan Gandhi' },        // Plant Head / COO
  { username: 'management',   email: 'sankalp.jaithalia@lakecement.co.tz',     full_name: 'Sankalp Jaithalia' },   // CFO
  { username: 'sales',        email: 'indra.pathak@lakecement.co.tz',          full_name: 'IPN Pathak' },          // Strategic Business Head + Sales HOD
  { username: 'purchase_hod', email: 'sajiv.kumar@lakecement.co.tz',           full_name: 'Sajiv Kumar' },         // General Manager + Purchase HOD

  // MD — Kush Patel. Email not yet supplied; add here when it arrives.
  // { username: 'md',        email: '…@lakecement.co.tz',                     full_name: 'Kush Patel' },
];

const APPLY = process.argv.includes('--apply');

function preflight() {
  const errors = [];
  const seen = new Map();
  for (const p of ROSTER) {
    const key = p.email.toLowerCase();
    if (seen.has(key)) errors.push(`duplicate email ${p.email} on '${p.username}' and '${seen.get(key)}'`);
    seen.set(key, p.username);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errors.push(`malformed email on '${p.username}': ${p.email}`);
  }
  return errors;
}

async function main() {
  const bad = preflight();
  if (bad.length) {
    console.error('Roster is inconsistent — nothing was written:');
    bad.forEach(e => console.error('  ✗ ' + e));
    process.exit(1);
  }

  const { rows } = await db.query(
    `SELECT username, full_name, email, role, department, level, active, must_change_password
       FROM users WHERE username = ANY($1)`,
    [ROSTER.map(p => p.username)]
  );
  const existing = new Map(rows.map(r => [r.username, r]));

  const missing = ROSTER.filter(p => !existing.has(p.username));
  if (missing.length) {
    console.error(`These accounts do not exist, so there is nothing to rename: ${missing.map(m => m.username).join(', ')}`);
    console.error('Run `npm run seed` first, or fix the roster. Nothing was written.');
    process.exit(1);
  }

  const notHod = ROSTER.filter(p => existing.get(p.username).level !== 'hod');
  if (notHod.length) {
    console.error(`Not level='hod' — this roster is L1 only: ${notHod.map(m => `${m.username}(${existing.get(m.username).level})`).join(', ')}`);
    console.error('Nothing was written.');
    process.exit(1);
  }

  console.log(APPLY ? '\nApplying roster…\n' : '\nDRY RUN — nothing will be written. Re-run with --apply to commit.\n');
  console.log('account        role         dept        name                     email                                  password');
  console.log('─'.repeat(122));

  for (const p of ROSTER) {
    const cur  = existing.get(p.username);
    const dept = p.department || cur.department;
    const pw   = cur.must_change_password ? 'must change at login' : 'already set by holder';

    if (APPLY) {
      await db.query(
        `UPDATE users SET full_name = $2, email = $3, department = $4, email_verified = false
          WHERE username = $1`,
        [p.username, p.full_name, p.email, dept]
      );
    }
    const deptNote = p.department && p.department !== cur.department ? `${cur.department}→${p.department}` : dept;
    console.log(
      p.username.padEnd(14),
      cur.role.padEnd(12),
      deptNote.padEnd(11),
      p.full_name.padEnd(24),
      p.email.padEnd(38),
      pw
    );
  }

  console.log('─'.repeat(122));
  console.log(`${ROSTER.length} L1/HOD accounts ${APPLY ? 'updated' : 'would be updated'}.`);
  console.log('Unchanged for every row: password, role, level, active. email_verified is set false — nobody is verified until they follow a link.');

  if (APPLY) {
    const { rows: left } = await db.query(
      `SELECT username, full_name, department, level FROM users
        WHERE email IS NULL AND department NOT IN ('AUTOMATION','TEST') AND username NOT LIKE 'uitest%'
        ORDER BY department, level DESC, username`
    );
    console.log(`\nStill without an email (${left.length}):`);
    left.forEach(r => console.log(`  ${r.username.padEnd(20)} ${r.level.padEnd(8)} ${r.department}`));
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
