/*
  scripts/restore-drill.js — prove the newest backup actually restores.

  A backup that has never been restored is a hope, not a backup. This
  drill: takes the newest dump in BACKUP_DIR (or the file passed as an
  argument), restores it into a SCRATCH database (lcl_mis_restore_drill —
  never the live one), verifies table presence and the user count against
  the live database, then drops the scratch database.

  Usage: npm run restore:drill             (newest dump in BACKUP_DIR)
         node scripts/restore-drill.js path\to\file.dump

  Run this monthly (see docs/RUNBOOK.md). Output ends with one line:
  RESTORE_DRILL_RESULT {json}
*/

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');
const { spawn }  = require('child_process');
const { findPgTool } = require('../services/backup');

const DRILL_DB = 'lcl_mis_restore_drill'; // scratch — created and dropped here

function newestDump() {
  const dir = process.env.BACKUP_DIR;
  if (!dir || !fs.existsSync(dir)) throw new Error('BACKUP_DIR is not configured or does not exist');
  const dumps = fs.readdirSync(dir).filter(f => /^lcl_mis-.*\.dump$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!dumps.length) throw new Error('no lcl_mis-*.dump files in ' + dir);
  return path.join(dir, dumps[0].f);
}

function connCfg(database) {
  return {
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database,
  };
}

/* CREATE/DROP DATABASE needs CREATEDB rights. Either grant the app user
   that once (ALTER USER <user> CREATEDB;) or set PG_ADMIN_USER /
   PG_ADMIN_PASSWORD in .env — used ONLY for these admin statements. */
async function adminQuery(sql) {
  const c = new Client({
    ...connCfg('postgres'),
    user: process.env.PG_ADMIN_USER || process.env.DB_USER,
    password: process.env.PG_ADMIN_PASSWORD || process.env.DB_PASSWORD,
  });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

function pgRestore(dump) {
  const tool = findPgTool('pg_restore');
  return new Promise((resolve, reject) => {
    const child = spawn(tool, [
      '--no-owner', '--no-privileges', '--no-password',
      '-h', process.env.DB_HOST || 'localhost',
      '-p', process.env.DB_PORT || '5432',
      '-U', process.env.DB_USER,
      '-d', DRILL_DB,
      dump,
    ], { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD } });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('pg_restore exited ' + code + ': ' + stderr.slice(0, 500))));
  });
}

(async () => {
  const dump = process.argv[2] || newestDump();
  console.log('Restore drill using: ' + dump);

  await adminQuery(`DROP DATABASE IF EXISTS ${DRILL_DB}`);
  await adminQuery(`CREATE DATABASE ${DRILL_DB}`);

  let result;
  try {
    await pgRestore(dump);

    // Verify the restored copy against the live database
    const drill = new Client(connCfg(DRILL_DB));
    await drill.connect();
    const live = new Client(connCfg(process.env.DB_NAME));
    await live.connect();
    try {
      const tables = (await drill.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`)).rows.map(r => r.table_name);
      const usersRestored = (await drill.query('SELECT COUNT(*)::int AS c FROM users')).rows[0].c;
      const usersLive     = (await live.query('SELECT COUNT(*)::int AS c FROM users')).rows[0].c;
      const reportsRestored = (await drill.query('SELECT COUNT(*)::int AS c FROM daily_reports')).rows[0].c;

      result = {
        ok: tables.includes('users') && tables.includes('daily_reports') &&
            tables.includes('kpi_overrides') && usersRestored > 0 && usersRestored === usersLive,
        dump: path.basename(dump),
        tables: tables.length,
        users_restored: usersRestored,
        users_live: usersLive,
        daily_reports_restored: reportsRestored,
      };
    } finally {
      await drill.end();
      await live.end();
    }
  } finally {
    await adminQuery(`DROP DATABASE IF EXISTS ${DRILL_DB}`).catch(() => { /* best effort */ });
  }

  console.log('RESTORE_DRILL_RESULT ' + JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})().catch(err => {
  console.error('❌ Restore drill failed:', err.message);
  console.log('RESTORE_DRILL_RESULT ' + JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
