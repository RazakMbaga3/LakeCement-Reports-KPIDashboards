/*
  db/index.js — PostgreSQL connection pool

  A "pool" means we keep several database connections open and ready,
  rather than opening and closing one for every request.
  Think of it as keeping 10 phone lines open instead of dialing every time.
*/

const { Pool, types } = require('pg');
require('dotenv').config();

// Return SQL DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date
// objects. Without this, a record_date of 2026-07-05 serializes as
// '2026-07-04T21:00:00.000Z' (local UTC+3 shifted to UTC) and the frontend
// maps it to the wrong day.
types.setTypeParser(1082, v => v);

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Render's external Postgres endpoint requires SSL; its internal endpoint
  // (used by the deployed backend itself) doesn't need it. Opt in via env
  // so local scripts can reach the external host without affecting prod.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Test the connection when the server starts
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    return;
  }
  release();
  console.log('✅ Connected to PostgreSQL database');
});

/* Run fn(client) inside BEGIN/COMMIT, ROLLBACK on any throw — for the
   handful of routes that write more than one table for a single logical
   action (e.g. the daily_reports upsert + its audit_log row) and need
   both to land or neither to, rather than the audit trail silently
   missing an entry a client already saw as "saved". fn must use the
   client it's given (not the pool) for every query in the transaction. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection may already be dead */ });
    throw err;
  } finally {
    client.release();
  }
}
pool.withTransaction = withTransaction;

module.exports = pool;
