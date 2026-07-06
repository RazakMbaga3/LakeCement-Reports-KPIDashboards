/*
  scripts/service-uninstall.js — remove the LakeCementMIS Windows service.
  Run in an ADMINISTRATOR shell:  npm run service:uninstall
*/

const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'LakeCementMIS',
  script: path.join(__dirname, '..', 'server.js'),
});

svc.on('uninstall', () => console.log('✅ LakeCementMIS service removed.'));
svc.on('error', err => { console.error('❌ Service error:', err); process.exit(1); });

console.log('Removing Windows service "LakeCementMIS"…');
svc.uninstall();
