/*
  scripts/service-install.js — install the backend as a Windows service.

  Run ONCE, in an ADMINISTRATOR shell, on the machine that should host
  the MIS (the plant server):

      cd backend
      npm run service:install

  The service ("LakeCementMIS") starts automatically at boot and
  restarts if the process crashes — the "reboot brings everything back"
  guarantee. Uninstall with npm run service:uninstall.
  Requires .env to be complete first (DB, JWT_SECRET, ALLOWED_ORIGIN…).
*/

const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'LakeCementMIS',
  description: 'Lake Cement MIS backend (Express + PostgreSQL) — Nyati Dashboard',
  script: path.join(__dirname, '..', 'server.js'),
  workingDirectory: path.join(__dirname, '..'),
  // restart behaviour: node-windows retries with backoff by default
  grow: 0.25,
  wait: 2,
  maxRetries: 40,
});

svc.on('install', () => { console.log('✅ Service installed — starting…'); svc.start(); });
svc.on('alreadyinstalled', () => console.log('Service is already installed. Use npm run service:uninstall first to reinstall.'));
svc.on('start', () => console.log('✅ LakeCementMIS service is running (starts automatically at boot).'));
svc.on('invalidinstallation', () => console.error('❌ Invalid installation detected.'));
svc.on('error', err => { console.error('❌ Service error:', err); process.exit(1); });

console.log('Installing Windows service "LakeCementMIS"… (requires an Administrator shell)');
svc.install();
