/*
  Global setup — creates one dedicated e2e account per role under test.

  It deliberately does NOT reuse the seeded staff accounts: most of them still
  carry must_change_password = true (requireAuth 403s every non-auth route
  until they change it), and several have already had their real password
  changed by the people using them. Logging in as a real user would either
  fail or force us to overwrite someone's password.

  Every account created here is prefixed 'e2e_' and removed by
  global-teardown.js, along with anything it wrote.
*/
const bcrypt = require('../backend/node_modules/bcryptjs');
const { pool } = require('./fixtures/db');
const { ROLES, FORM_OWNING_ROLES, E2E_PASSWORD, username } = require('./fixtures/roles');

const SALT_ROUNDS = 12;

module.exports = async () => {
  const hash = await bcrypt.hash(E2E_PASSWORD, SALT_ROUNDS);

  /* Every role at level 'hod', plus an 'officer' twin for each role that owns
     a daily form — the approval workflow only exists between those two. */
  const accounts = [
    ...ROLES.map(r => ({ role: r.role, level: 'hod' })),
    ...FORM_OWNING_ROLES.map(role => ({ role, level: 'officer' })),
  ];

  for (const r of accounts) {
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, department, level,
                          must_change_password, active)
       VALUES ($1, $2, $3, $4, $5, $6, false, true)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role,
             level = EXCLUDED.level,
             must_change_password = false,
             active = true,
             failed_attempts = 0,
             locked_until = NULL,
             token_version = users.token_version + 1`,
      [username(r.role, r.level), hash, 'E2E ' + r.role + ' (' + r.level + ')', r.role, 'E2E', r.level]
    );
  }

  /* Year 2001 is the harness's write sandbox: valid per routes/kpi.js's zYear
     (min 2000) and far outside any real fiscal year, so a write test can never
     collide with, or be mistaken for, plant data. Start every run clean. */
  await pool.query('DELETE FROM kpi_monthly WHERE year = 2001');

  /* Both write sandboxes: year-2001 for kpi_monthly, 1999 dates for daily_reports. */
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  /* 2098 is draft-reaccess.spec.js's sandbox: it must sort NEWEST, because the history
     panel only sees the newest 120 days of a form. */
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '2098-01-01' AND '2098-12-31'");

  console.log(`[e2e] ${accounts.length} harness accounts ready; sandboxes cleared`);
};
