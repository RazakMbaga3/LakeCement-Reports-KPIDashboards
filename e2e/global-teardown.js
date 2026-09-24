/*
  Global teardown — removes everything global-setup.js and the specs created.

  Order matters: audit_log.user_id and kpi_monthly.updated_by are plain
  REFERENCES users(id) with no ON DELETE clause, so the users can only be
  dropped after the rows that point at them.
*/
const { pool } = require('./fixtures/db');

const HARNESS_USERS = `SELECT id FROM users WHERE username LIKE 'e2e\_%'`;

module.exports = async () => {
  // 1. The declared write sandboxes.
  await pool.query('DELETE FROM kpi_monthly WHERE year = 2001');
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  /* 2098 is draft-reaccess.spec.js's sandbox: it must sort NEWEST, because the history
     panel only sees the newest 120 days of a form. */
  await pool.query("DELETE FROM daily_reports WHERE record_date BETWEEN '2098-01-01' AND '2098-12-31'");
  /* report_revisions is append-only in production — nothing in the app ever
     deletes from it, by design. The harness is the one exception: it writes
     a revision for every sandbox submit, and without this every e2e run
     would leave those rows behind forever. Scoped to the 1999 sandbox only,
     so a real revision can never be caught by it. */
  await pool.query("DELETE FROM report_revisions WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  /* report_amendments and the system-authored audit rows the expiry sweeper
     writes ('system': no user id, no e2e_ username, so the by-user deletes below
     never find them). Sandbox dates only — nothing real carries a 1999 date. */
  await pool.query("DELETE FROM report_amendments WHERE record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  await pool.query("DELETE FROM report_amendments WHERE record_date BETWEEN '2098-01-01' AND '2098-12-31'");
  await pool.query("DELETE FROM audit_log WHERE username = 'system' AND record_date BETWEEN '1999-01-01' AND '1999-12-31'");
  // The sweeper's revert raises this alert through the watchdog. Sandbox dates only: they are in the detail text.
  await pool.query("DELETE FROM alerts WHERE kind LIKE 'amendment-expired:%' AND detail LIKE '%for 1999-%'");
  await pool.query("DELETE FROM report_revisions WHERE record_date BETWEEN '2098-01-01' AND '2098-12-31'");

  /* 2. Anything else a harness account authored. A test does not only write
        where it means to: merely OPENING mines-report.html persists a
        month-config record (it seeds April 2026 opening stocks from the
        reference workbook the first time it finds none), so a page-load
        test left a real 2026 row behind and the user delete below failed on
        its foreign key. Nothing a real person did is ever attributed to an
        e2e_* account, so these rows are test artifacts by definition. */
  await pool.query(`DELETE FROM daily_reports WHERE submitted_by IN (${HARNESS_USERS}) OR updated_by IN (${HARNESS_USERS})`);
  await pool.query(`UPDATE kpi_monthly SET updated_by = NULL WHERE updated_by IN (${HARNESS_USERS})`);
  /* Match on BOTH columns: audit_log.username is a denormalised copy, and
     rows written before a user row existed (or after it was removed by an
     interrupted run) carry the name with a null user_id. Deleting only by
     user_id left those behind. */
  await pool.query(
    `DELETE FROM audit_log
     WHERE username LIKE 'e2e\_%'
        OR user_id IN (SELECT id FROM users WHERE username LIKE 'e2e\_%')`
  );
  /* The revision trail for everything a harness account wrote. The date-range
     delete above only reaches the 1999 sandbox, but a test does not only write
     where it means to (see step 2): cpp-entry and the mines page-load test
     both land on real 2026 dates, and the daily_reports rows they leave are
     removed by author just above — so the revision each one wrote has to go
     the same way or it is orphaned for good. Same rule as audit_log: match
     BOTH columns, because actor_name is a denormalised copy that outlives the
     account (migration 025 made actor_id ON DELETE SET NULL precisely so this
     table never blocks a user delete, which means the id alone stops matching
     the moment a user row is gone). Harness full_names are all "E2E <role>
     (<level>)", and no real person is ever attributed to one. */
  await pool.query(
    `DELETE FROM report_revisions
     WHERE actor_name LIKE 'E2E %'
        OR actor_id IN (${HARNESS_USERS})`
  );
  /* A request a harness account made against a real-dated report, if a test
     strayed off the sandbox. The name is denormalised for exactly this: the id
     goes NULL when the user row is deleted (ON DELETE SET NULL). */
  await pool.query(`DELETE FROM report_amendments WHERE requested_by_name LIKE 'E2E %' OR decided_by_name LIKE 'E2E %'`);
  const { rowCount } = await pool.query(`DELETE FROM users WHERE username LIKE 'e2e\_%'`);
  console.log(`[e2e] cleaned up ${rowCount} harness accounts, both write sandboxes and anything they authored`);
  await pool.end();
};
