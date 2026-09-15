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

require('../config/env');
const bcrypt = require('bcryptjs');
const db     = require('./index');

const SALT_ROUNDS = 12; // higher = slower to hash = harder to brute force

const USERS = [
  { username: 'admin',      password: 'Admin@LCL2026',  name: 'System Administrator',       role: 'admin',      dept: 'IT',                level: 'hod' },
  { username: 'md',         password: 'MD@LCL2026',     name: 'Managing Director',          role: 'md',         dept: 'CORPORATE',         level: 'hod' },
  { username: 'planthead',  password: 'Plant@LCL2026',  name: 'Plant Head',                 role: 'md',         dept: 'OPERATIONS',        level: 'hod' },
  { username: 'management', password: 'Mgt@LCL2026',    name: 'Senior Management',          role: 'management', dept: 'CORPORATE',         level: 'hod' },

  { username: 'hr_officer', password: 'HRO@LCL2026',    name: 'HR & Admin Officer',          role: 'hr',         dept: 'HR & ADMIN',        level: 'officer' },
  { username: 'hr_senior',  password: 'HRS@LCL2026',    name: 'HR & Admin Senior Officer',   role: 'hr',         dept: 'HR & ADMIN',        level: 'senior' },
  { username: 'hr',         password: 'HR@LCL2026',     name: 'HR & Admin Manager',         role: 'hr',         dept: 'HR & ADMIN',        level: 'hod' },

  { username: 'finance_officer', password: 'FinO@LCL2026', name: 'Finance Officer',          role: 'finance',    dept: 'FINANCE',           level: 'officer' },
  { username: 'finance_senior',  password: 'FinS@LCL2026', name: 'Finance Senior Officer',   role: 'finance',    dept: 'FINANCE',           level: 'senior' },
  { username: 'finance',    password: 'Fin@LCL2026',    name: 'Finance & Accounts Manager', role: 'finance',    dept: 'FINANCE',           level: 'hod' },

  { username: 'stores_officer', password: 'StrO@LCL2026', name: 'Stores Officer',            role: 'stores',     dept: 'STORES',            level: 'officer' },
  { username: 'stores_senior',  password: 'StrS@LCL2026', name: 'Stores Senior Officer',     role: 'stores',     dept: 'STORES',            level: 'senior' },
  { username: 'stores',     password: 'Str@LCL2026',    name: 'Purchase & Stores Manager',  role: 'stores',     dept: 'STORES',            level: 'hod' },

  { username: 'purchase_officer', password: 'PurchO@LCL2026', name: 'Purchase Officer',      role: 'purchase',   dept: 'PURCHASE',          level: 'officer' },
  { username: 'purchase_senior',  password: 'PurchS@LCL2026', name: 'Purchase Senior Officer', role: 'purchase', dept: 'PURCHASE',          level: 'senior' },
  { username: 'purchase_hod',     password: 'PurchH@LCL2026', name: 'Purchase HOD',          role: 'purchase',   dept: 'PURCHASE',          level: 'hod' },

  { username: 'cpp_officer', password: 'CPPO@LCL2026',  name: 'Power Plant Officer',         role: 'cpp',        dept: 'POWER PLANT',       level: 'officer' },
  { username: 'cpp_senior',  password: 'CPPS@LCL2026',  name: 'Power Plant Senior Officer',  role: 'cpp',        dept: 'POWER PLANT',       level: 'senior' },
  { username: 'cpp',        password: 'CPP@LCL2026',    name: 'Power Plant HOD',            role: 'cpp',        dept: 'POWER PLANT',       level: 'hod' },

  { username: 'pm_officer', password: 'PMO@LCL2026',    name: 'P & M Officer',               role: 'pm',         dept: 'P & M',             level: 'officer' },
  { username: 'pm_senior',  password: 'PMS@LCL2026',    name: 'P & M Senior Officer',        role: 'pm',         dept: 'P & M',             level: 'senior' },
  { username: 'pm',         password: 'PM@LCL2026',     name: 'Projects & Maintenance HOD', role: 'pm',         dept: 'P & M',             level: 'hod' },

  { username: 'it_officer', password: 'ITO@LCL2026',    name: 'IT Officer',                  role: 'it',         dept: 'IT',                level: 'officer' },
  { username: 'it_senior',  password: 'ITS@LCL2026',    name: 'IT Senior Officer',           role: 'it',         dept: 'IT',                level: 'senior' },
  { username: 'it',         password: 'IT@LCL2026',     name: 'IT Manager',                 role: 'it',         dept: 'IT',                level: 'hod' },

  { username: 'logistics_officer', password: 'LogO@LCL2026', name: 'Logistics Officer',      role: 'logistics',  dept: 'LOGISTICS',         level: 'officer' },
  { username: 'logistics_senior',  password: 'LogS@LCL2026', name: 'Logistics Senior Officer', role: 'logistics', dept: 'LOGISTICS',        level: 'senior' },
  { username: 'logistics',  password: 'Log@LCL2026',    name: 'Logistics & Workshops HOD',  role: 'logistics',  dept: 'LOGISTICS',         level: 'hod' },

  // username/role stay 'mining' — internal key, unrelated to the visible "Quarry" rename.
  { username: 'mining_officer', password: 'MinO@LCL2026', name: 'Quarry Officer',            role: 'mining',     dept: 'QUARRY',            level: 'officer' },
  { username: 'mining_senior',  password: 'MinS@LCL2026', name: 'Quarry Senior Officer',     role: 'mining',     dept: 'QUARRY',            level: 'senior' },
  { username: 'mining',     password: 'Min@LCL2026',    name: 'Quarry Manager',             role: 'mining',     dept: 'QUARRY',            level: 'hod' },

  { username: 'production_officer', password: 'ProdO@LCL2026', name: 'Production & QC Officer', role: 'production', dept: 'PRODUCTION & QC', level: 'officer' },
  { username: 'production_senior',  password: 'ProdS@LCL2026', name: 'Production & QC Senior Officer', role: 'production', dept: 'PRODUCTION & QC', level: 'senior' },
  { username: 'production', password: 'Prod@LCL2026',   name: 'Production & QC Manager',   role: 'production', dept: 'PRODUCTION & QC',   level: 'hod' },

  { username: 'sales_officer', password: 'SalesO@LCL2026', name: 'Sales & Marketing Officer', role: 'sales',    dept: 'SALES & MARKETING', level: 'officer' },
  { username: 'sales_senior',  password: 'SalesS@LCL2026', name: 'Sales & Marketing Senior Officer', role: 'sales', dept: 'SALES & MARKETING', level: 'senior' },
  { username: 'sales',      password: 'Sales@LCL2026',  name: 'Sales & Marketing Manager',  role: 'sales',      dept: 'SALES & MARKETING', level: 'hod' },

  { username: 'ei_officer', password: 'EIO@LCL2026',    name: 'E & I Officer',                role: 'ei',        dept: 'E & I',             level: 'officer' },
  { username: 'ei_senior',  password: 'EIS@LCL2026',    name: 'E & I Senior Officer',         role: 'ei',        dept: 'E & I',             level: 'senior' },
  { username: 'ei',         password: 'EI@LCL2026',     name: 'Electrical & Instrumentation HOD', role: 'ei',    dept: 'E & I',             level: 'hod' },

  { username: 'packing_officer', password: 'PackO@LCL2026', name: 'Packing Officer',         role: 'packing',    dept: 'PACKING',           level: 'officer' },
  { username: 'packing_senior',  password: 'PackS@LCL2026', name: 'Packing Senior Officer',  role: 'packing',    dept: 'PACKING',           level: 'senior' },
  { username: 'packing',    password: 'Pack@LCL2026',   name: 'Packing Plant HOD',           role: 'packing',   dept: 'PACKING',           level: 'hod' },
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
  // Per-account skip, not an all-or-nothing abort: on a live system most of
  // USERS is already-live existing accounts (which must never be touched
  // here) sitting alongside brand-new usernames that still need inserting.
  // An abort-the-whole-run guard would block the new accounts too just
  // because unrelated existing ones are live.
  const live = force ? new Set() : new Set(await checkLiveAccounts());
  if (live.size) {
    console.log(`⏭  Skipping ${live.size} already-live account(s) (password already changed): ${[...live].join(', ')}`);
  }

  console.log('🌱 Seeding users...\n');

  for (const u of USERS) {
    if (live.has(u.username)) continue;
    try {
      const hash = await bcrypt.hash(u.password, SALT_ROUNDS);
      // must_change_password = true: these defaults are committed in git,
      // so every seeded account must set its own password at first login.
      await db.query(`
        INSERT INTO users (username, password_hash, full_name, role, department, level, must_change_password)
        VALUES ($1, $2, $3, $4, $5, $6, true)
        ON CONFLICT (username) DO UPDATE SET
          password_hash        = EXCLUDED.password_hash,
          full_name            = EXCLUDED.full_name,
          role                 = EXCLUDED.role,
          department           = EXCLUDED.department,
          level                = EXCLUDED.level,
          must_change_password = true
      `, [u.username, hash, u.name, u.role, u.dept, u.level]);

      console.log(`  ✅ ${u.username.padEnd(18)} (${u.role}/${u.level})`);
    } catch (err) {
      console.error(`  ❌ ${u.username}: ${err.message}`);
    }
  }

  console.log('\n✅ Seeding complete. All users created with hashed passwords.');
  console.log('⚠️  Remind all users to change their passwords after first login.');
  process.exit(0);
}

seed();
