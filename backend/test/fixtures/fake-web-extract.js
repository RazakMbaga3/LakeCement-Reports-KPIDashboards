/*
  Stand-in for integration/sales-dashboard/web_extract.py in
  test/integration-extract.test.js: run by Node (process.execPath) instead of
  Python, so the tests need no Python and no Odoo. Behaviour is chosen by
  FAKE_MODE in a file next to it (the child gets a minimal env on purpose, so
  an environment variable would not reach it).
*/
const fs = require('fs');
const path = require('path');

const mode = fs.readFileSync(path.join(__dirname, 'fake-web-extract.mode'), 'utf8').trim();
const counter = path.join(__dirname, 'fake-web-extract.runs');
fs.appendFileSync(counter, 'x');

const report = process.argv[2];
const out = s => process.stdout.write(typeof s === 'string' ? s : JSON.stringify(s));

switch (mode) {
  case 'ok':
    out({ ok: true, report, count: 3, env_keys: Object.keys(process.env).sort(), args: process.argv.slice(2) });
    process.exit(0);
    break;
  case 'odoo-down':
    out({ ok: false, status: 'odoo_unreachable', message: 'Cannot reach the Odoo database' });
    process.exit(2);
    break;
  case 'not-configured':
    out({ ok: false, status: 'not_configured', message: 'Odoo database settings not set in .env: PG_PASSWORD' });
    process.exit(3);
    break;
  case 'garbage':
    out('Traceback (most recent call last): boom');
    process.exit(1);
    break;
  case 'huge':
    out('x'.repeat(9 * 1024 * 1024));
    process.exit(0);
    break;
  case 'slow':
    setTimeout(() => { out({ ok: true, report }); process.exit(0); }, 5000);
    break;
  default:
    process.exit(1);
}
