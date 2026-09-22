/*
  scripts/create-import-service-accounts.js — one-time (idempotent) setup of
  dedicated, non-human login accounts for the Excel data-import pipeline
  (extract/import/patch/verify scripts in this directory).

  Why: the real 'production' and 'pm' logins are human accounts subject to
  the security-hardening password-rotation gate (must_change_password) —
  either still on the default git-committed password (blocked pending
  rotation) or already rotated by a real person to a password the import
  scripts can't know. Automated imports should never depend on either.
  These service accounts carry the same role (so form-access rules in
  forms/access-registry.js apply unchanged) but must_change_password=false
  and a random password generated fresh each run, printed once to the
  console — store it, it is not recoverable afterward (bcrypt is one-way).

  Each run generates a FRESH password for every account it touches, so a
  run rotates whatever was stored for it last time. Name the accounts you
  want as arguments to touch only those and leave the rest' passwords
  alone; with no arguments it does all of them, as it always has.

  Usage: node scripts/create-import-service-accounts.js [username ...]
*/
require('../config/env');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const SALT_ROUNDS = 12;

const ACCOUNTS = [
  { username: 'import-production', role: 'production', name: 'Data Import Service (Production)' },
  { username: 'import-pm',         role: 'pm',          name: 'Data Import Service (P&M/Power)' },
  /* Added 2026-09-22 for the Jul-Aug 2026 CPP backfill (scripts/import-cpp.js).
     role='cpp' is what FORM_ACCESS in forms/access-registry.js checks for the
     `cpp` form, and level defaults to 'hod', so an imported day lands
     'approved' exactly like the Apr-Jun rows the CPP HOD's own account
     posted — a historical report the plant already signed off in Excel has
     nothing left to approve. */
  { username: 'import-cpp',        role: 'cpp',         name: 'Data Import Service (CPP)' },
];

function genPassword() {
  // 18 bytes -> 24-char base64url, well above any reasonable strength bar
  return crypto.randomBytes(18).toString('base64url');
}

async function main() {
  /* Which accounts this run touches. Named on the command line = only
     those, so rotating one account's password does not silently
     invalidate the others'. No arguments = all of them. */
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const unknown = only.filter((u) => !ACCOUNTS.some((a) => a.username === u));
  if (unknown.length) {
    console.error(`Unknown account(s): ${unknown.join(', ')}. Known: ${ACCOUNTS.map((a) => a.username).join(', ')}`);
    process.exit(2);
  }
  const selected = only.length ? ACCOUNTS.filter((a) => only.includes(a.username)) : ACCOUNTS;

  console.log('Creating/refreshing dedicated import service accounts...\n');
  for (const acct of selected) {
    const password = genPassword();
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'AUTOMATION', true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
        must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [acct.username, hash, acct.name, acct.role]);
    console.log(`  ✅ ${acct.username.padEnd(20)} role=${acct.role.padEnd(12)} password=${password}`);
  }
  console.log('\nStore these passwords now (e.g. in the team password manager) — they cannot be retrieved again.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
