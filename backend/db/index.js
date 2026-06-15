/*
  db/index.js — PostgreSQL connection pool

  A "pool" means we keep several database connections open and ready,
  rather than opening and closing one for every request.
  Think of it as keeping 10 phone lines open instead of dialing every time.
*/

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
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

module.exports = pool;
