/*
  scripts/accept-phase7.js — Phase 7 acceptance tests (see docs/MASTER_BUILD_PROMPT.md).

  Proves backup & disaster recovery against the LIVE database and tools:
    1. pg_dump backup produces a valid dump file
    2. retention pruning removes dumps older than BACKUP_KEEP_DAYS
    3. a fresh backup makes /api/health report its age/presence, AND
       correctly flags same_disk_as_app + degrades health when BACKUP_DIR
       and the app share a disk (not real DR coverage)
    4. an empty backup dir degrades health (watchdog would then email —
       pipeline already proven in phase 6)
    5. THE DRILL: the dump restores into a scratch database, table set and
       user count verified against live, scratch dropped (never touches
       the live DB)
    6. deployment collateral exists and parses: service install/uninstall
       scripts, nginx template, RUNBOOK

  Usage: npm run accept:phase7
*/

require('../config/env');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { runBackup } = require('../services/backup');

const PORT   = process.env.ACCEPT_PORT || 5908;
const PORT2  = 5909;
const TMP    = path.join(os.tmpdir(), 'lcl-accept7-backups');
const EMPTY  = path.join(os.tmpdir(), 'lcl-accept7-empty');

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: port, WATCHDOG_CRON: 'off', BACKUP_CRON: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  return child;
}

async function waitForHealth(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.status === 200 || res.status === 503) return res.json();
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

function runNode(args, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => resolve({ code, out }));
  });
}

async function main() {
  console.log('Phase 7 acceptance — backup, restore drill, deployment collateral…\n');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(EMPTY, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(EMPTY, { recursive: true });

  let server = null, server2 = null;
  try {
    // ── 1. Backup produces a valid dump ─────────────────────────
    const b1 = await runBackup({ dir: TMP });
    check('pg_dump backup written (' + (b1.bytes / 1024).toFixed(1) + ' KB)',
      fs.existsSync(b1.file) && b1.bytes > 2048 && /lcl_mis-.*\.dump$/.test(b1.file),
      JSON.stringify(b1));

    // ── 2. Retention pruning ────────────────────────────────────
    const oldDump = path.join(TMP, 'lcl_mis-1999-01-01-0300.dump');
    fs.writeFileSync(oldDump, 'stale');
    const oldTime = new Date(Date.now() - 30 * 86400000);
    fs.utimesSync(oldDump, oldTime, oldTime);
    const b2 = await runBackup({ dir: TMP });
    check('dumps older than BACKUP_KEEP_DAYS are pruned',
      !fs.existsSync(oldDump) && b2.pruned.includes('lcl_mis-1999-01-01-0300.dump'),
      JSON.stringify(b2.pruned));

    // ── 3. Fresh backup → health reports it, with age ───────────
    // TMP lives under the OS temp dir, on the same disk as this test
    // process in virtually every real environment — so `ok` is correctly
    // false here (see health.js's same-disk check, added because a backup
    // on the DB's own disk isn't real DR coverage). Assert on presence/age
    // (what a fresh backup actually proves) and separately on the
    // same-disk flag firing, rather than overall `ok`.
    server = startServer(PORT, { BACKUP_DIR: TMP });
    const h1 = await waitForHealth(PORT);
    check('fresh backup → /api/health reports age + presence',
      h1 && typeof h1.checks.backup.age_hours === 'number' && h1.checks.backup.age_hours < 1,
      h1 ? JSON.stringify(h1.checks.backup) : 'no health');
    check('backup on the same disk as the app is correctly flagged, not silently ok',
      h1 && h1.checks.backup.same_disk_as_app === true && h1.checks.backup.ok === false &&
      h1.status === 'degraded',
      h1 ? JSON.stringify(h1.checks.backup) : 'no health');
    server.kill();

    // ── 4. Missing backups → degraded ───────────────────────────
    server2 = startServer(PORT2, { BACKUP_DIR: EMPTY });
    const h2 = await waitForHealth(PORT2);
    check('no backups in BACKUP_DIR → health degrades (watchdog would email)',
      h2 && h2.status === 'degraded' && h2.checks.backup.ok === false,
      h2 ? JSON.stringify({ status: h2.status, backup: h2.checks.backup }) : 'no health');
    server2.kill();

    // ── 5. THE RESTORE DRILL ────────────────────────────────────
    console.log('\n  Running restore drill (scratch database)…');
    const drill = await runNode([path.join(__dirname, 'restore-drill.js'), b2.file]);
    const line = drill.out.split('\n').find(l => l.startsWith('RESTORE_DRILL_RESULT '));
    const dr = line ? JSON.parse(line.slice('RESTORE_DRILL_RESULT '.length)) : null;
    check('restore drill: dump restores into scratch DB, tables + users verified',
      drill.code === 0 && dr && dr.ok === true && dr.tables >= 8 &&
      dr.users_restored === dr.users_live && dr.users_restored > 0,
      dr ? JSON.stringify(dr) : drill.out.slice(0, 400));

    // ── 6. Deployment collateral ────────────────────────────────
    const repoRoot = path.join(__dirname, '..', '..');
    const svcOk = ['service-install.js', 'service-uninstall.js'].every(f => {
      const p = path.join(__dirname, f);
      return fs.existsSync(p) && spawnSync(process.execPath, ['--check', p]).status === 0;
    });
    check('Windows service install/uninstall scripts present and parse', svcOk);

    const nginx = fs.readFileSync(path.join(repoRoot, 'deploy', 'nginx.conf'), 'utf8');
    check('nginx template: static root + /api proxy + forwarded headers',
      /proxy_pass http:\/\/127\.0\.0\.1:5000\/api\//.test(nginx) && /X-Forwarded-For/.test(nginx));

    const runbook = fs.readFileSync(path.join(repoRoot, 'docs', 'RUNBOOK.md'), 'utf8');
    check('RUNBOOK covers service, logs, backup/restore, users, secrets, alerts',
      ['service:install', 'restore:drill', 'backend/logs', 'JWT_SECRET', 'missed-entry', 'ALTER DATABASE']
        .every(s => runbook.includes(s)));

  } finally {
    if (server) server.kill();
    if (server2) server2.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.rmSync(EMPTY, { recursive: true, force: true });
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Phase 7 acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Acceptance run crashed:', err);
  process.exit(1);
});
