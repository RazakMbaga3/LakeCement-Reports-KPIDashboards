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

  Usage: node scripts/create-import-service-accounts.js
*/
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const SALT_ROUNDS = 12;

const ACCOUNTS = [
  { username: 'import-production', role: 'production', name: 'Data Import Service (Production)' },
  { username: 'import-pm',         role: 'pm',          name: 'Data Import Service (P&M/Power)' },
];

function genPassword() {
  // 18 bytes -> 24-char base64url, well above any reasonable strength bar
  return crypto.randomBytes(18).toString('base64url');
}

async function main() {
  console.log('Creating/refreshing dedicated import service accounts...\n');
  for (const acct of ACCOUNTS) {
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
