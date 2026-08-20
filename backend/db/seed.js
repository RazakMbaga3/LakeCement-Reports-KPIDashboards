/*
  db/seed.js — Initial Data Setup

  Run this ONCE after creating the database tables.
  It creates all users with bcrypt-hashed passwords.

  Usage: node db/seed.js

  CONCEPT: bcrypt hashing
  bcrypt takes a plain password ("Admin@LCL2026") and scrambles it
  into a hash ("$2a$12$..."). The hash is what gets stored.
  You can NEVER reverse a hash back to the original password.
  When someone logs in, bcrypt hashes what they typed and compares
  hashes — never comparing plain text.
*/

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db     = require('./index');

const SALT_ROUNDS = 12; // higher = slower to hash = harder to brute force

const USERS = [
  { username: 'admin',      password: 'Admin@LCL2026',  name: 'System Administrator',       role: 'admin',      dept: 'IT' },
  { username: 'md',         password: 'MD@LCL2026',     name: 'Managing Director',          role: 'md',         dept: 'CORPORATE' },
  { username: 'planthead',  password: 'Plant@LCL2026',  name: 'Plant Head',                 role: 'md',         dept: 'OPERATIONS' },
  { username: 'management', password: 'Mgt@LCL2026',    name: 'Senior Management',          role: 'management', dept: 'CORPORATE' },
  { username: 'hr',         password: 'HR@LCL2026',     name: 'HR & Admin Manager',         role: 'hr',         dept: 'HR & ADMIN' },
  { username: 'finance',    password: 'Fin@LCL2026',    name: 'Finance & Accounts Manager', role: 'finance',    dept: 'FINANCE' },
  { username: 'stores',     password: 'Str@LCL2026',    name: 'Purchase & Stores Manager',  role: 'stores',     dept: 'STORES' },
  { username: 'cpp',        password: 'CPP@LCL2026',    name: 'Power Plant HOD',            role: 'cpp',        dept: 'POWER PLANT' },
  { username: 'pm',         password: 'PM@LCL2026',     name: 'Projects & Maintenance HOD', role: 'pm',         dept: 'P & M' },
  { username: 'it',         password: 'IT@LCL2026',     name: 'IT Manager',                 role: 'it',         dept: 'IT' },
  { username: 'logistics',  password: 'Log@LCL2026',    name: 'Logistics & Workshops HOD',  role: 'logistics',  dept: 'LOGISTICS' },
  { username: 'mining',     password: 'Min@LCL2026',    name: 'Quarry Manager',             role: 'mining',     dept: 'QUARRY' },
  // username/role stay 'mining' — internal key, unrelated to the visible "Quarry" rename.
  { username: 'production', password: 'Prod@LCL2026',   name: 'Production & QC Manager',   role: 'production', dept: 'PRODUCTION & QC' },
  { username: 'sales',      password: 'Sales@LCL2026',  name: 'Sales & Marketing Manager',  role: 'sales',      dept: 'SALES & MARKETING' },
];

/* Re-seeding resets EVERY listed user back to the default,
   committed-in-git password and forces a change again — fine on a fresh
   database, disruptive (and a little alarming) on a live one where real
   staff have already been using their own chosen passwords for weeks.
   Guard: if any of these accounts has already completed its first-login
   change (must_change_password = false), refuse unless --force is passed. */
async function checkLiveAccounts() {
  const { rows } = await db.query(
    `SELECT username FROM users WHERE username = ANY($1) AND must_change_password = false`,
    [USERS.map(u => u.username)]
  );
  return rows.map(r => r.username);
}

async function seed() {
  const force = process.argv.includes('--force');
  if (!force) {
    const live = await checkLiveAccounts();
    if (live.length) {
      console.error(`❌ Refusing to re-seed: ${live.length} account(s) have already completed their first-login password change: ${live.join(', ')}.`);
      console.error('   Re-seeding would reset them all back to the default password committed in git and force a change again.');
      console.error('   If you really mean to do this, re-run with: npm run seed -- --force');
      process.exit(1);
    }
  }

  console.log('🌱 Seeding users...\n');

  for (const u of USERS) {
    try {
      const hash = await bcrypt.hash(u.password, SALT_ROUNDS);
      // must_change_password = true: these defaults are committed in git,
      // so every seeded account must set its own password at first login.
      await db.query(`
        INSERT INTO users (username, password_hash, full_name, role, department, must_change_password)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (username) DO UPDATE SET
          password_hash        = EXCLUDED.password_hash,
          full_name            = EXCLUDED.full_name,
          role                 = EXCLUDED.role,
          department           = EXCLUDED.department,
          must_change_password = true
      `, [u.username, hash, u.name, u.role, u.dept]);

      console.log(`  ✅ ${u.username.padEnd(12)} (${u.role})`);
    } catch (err) {
      console.error(`  ❌ ${u.username}: ${err.message}`);
    }
  }

  console.log('\n✅ Seeding complete. All users created with hashed passwords.');
  console.log('⚠️  Remind all users to change their passwords after first login.');
  process.exit(0);
}

seed();
