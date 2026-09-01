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
  const { rowCount } = await pool.query(`DELETE FROM users WHERE username LIKE 'e2e\_%'`);
  console.log(`[e2e] cleaned up ${rowCount} harness accounts, both write sandboxes and anything they authored`);
  await pool.end();
};
