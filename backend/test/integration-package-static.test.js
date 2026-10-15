/*
  test/integration-package-static.test.js — standing guarantees of the
  Integration Package (integration/sales-dashboard/), checked without Python,
  Odoo or nginx:

    1. this server can never send the package's e-mails: no sending or
       scheduling script is vendored, and web_extract.py has no sending path
    2. the collaborator's files are byte-identical to the package copy
       (SHA256SUMS), so "we did not change their business logic" is checked,
       not claimed
    3. the nginx snippet keeps the shape that makes /sales-app/ both reachable
       and gated

  Usage: node --test test/integration-package-static.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DIR = path.join(REPO, 'integration', 'sales-dashboard');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    if (['.venv', '__pycache__'].includes(e.name)) return [];
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [path.relative(DIR, p).split(path.sep).join('/')];
  });
}

test('no sending or scheduling script is vendored', () => {
  const offenders = walk(DIR).filter(f =>
    /\.(ps1|bat|cmd|vbs|sh)$/i.test(f)
    || /^(send_|install_scheduled|deploy\.ps1|build_dashboard_excel|run_vehicles|dashboard_service)/i.test(path.basename(f)));
  assert.deepEqual(offenders, []);
});

test('web_extract.py never calls a sending or file-writing function', () => {
  const src = read(DIR, 'web_extract.py');
  for (const banned of [/\bvw\.send\s*\(/, /\bvw\.write\s*\(/, /--live/, /--email/, /Outlook/i, /smtplib/, /win32com/]) {
    const code = src.split('\n').filter(l => !/^\s*#/.test(l) && !/^\s*-/.test(l)).join('\n');
    assert.ok(!banned.test(code.replace(/"""[\s\S]*?"""/g, '')), `web_extract.py must not contain ${banned}`);
  }
  assert.match(src, /subprocess\.run = subprocess\.Popen = .*_refuse/, 'the outside-program guard must stay');
  assert.match(src, /tries=1/, 'the 10-minute retry sleeps must stay disabled inside a web request');
});

test("the collaborator's files match SHA256SUMS byte for byte", () => {
  const lines = read(DIR, 'SHA256SUMS').trim().split(/\r?\n/);
  assert.ok(lines.length >= 14, 'all vendored files are listed');
  for (const line of lines) {
    const [hash, rel] = [line.slice(0, 64), line.slice(66)];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');
    assert.equal(actual, hash, `${rel} differs from the package copy`);
  }
});

test('PROVENANCE.json lists exactly the vendored files', () => {
  const prov = JSON.parse(read(DIR, 'PROVENANCE.json'));
  const listed = Object.keys(prov.files).sort();
  const summed = read(DIR, 'SHA256SUMS').trim().split(/\r?\n/)
    .map(l => l.slice(66).replace('integration/sales-dashboard/', '')).sort();
  assert.deepEqual(listed, summed);
});

test('git keeps the vendored bytes exactly (-text) and never commits runtime secrets', () => {
  assert.match(read(REPO, '.gitattributes'), /^integration\/sales-dashboard\/\*\* -text$/m);
  const ignore = read(REPO, '.gitignore');
  for (const p of ['integration/sales-dashboard/users.toml', 'integration/sales-dashboard/.venv/']) {
    assert.ok(ignore.includes(p), `.gitignore must list ${p}`);
  }
  assert.match(ignore, /^\.env$/m, '.env is ignored everywhere');
});

test('nginx snippet: ^~ prefix, no path on proxy_pass, websocket headers, gate, own headers', () => {
  const s = read(REPO, 'deploy', 'nginx-sales-app.conf');
  assert.match(s, /location \^~ \/sales-app\/ \{/);
  assert.match(s, /proxy_pass http:\/\/127\.0\.0\.1:8501;/, 'no path after the port — keeps the /sales-app/ prefix');
  assert.match(s, /proxy_set_header Upgrade\s+\$http_upgrade;/);
  assert.match(s, /proxy_set_header Host\s+\$http_host;/);
  assert.match(s, /auth_request \/__lcl_sales_app_gate;/);
  assert.match(s, /location = \/__lcl_sales_app_gate \{\s*\n\s*internal;/);
  assert.match(s, /proxy_pass http:\/\/127\.0\.0\.1:5000\/api\/integration\/sales-app-gate;/);
  assert.match(s, /add_header X-Frame-Options\s+"SAMEORIGIN" always;/);
  assert.match(s, /frame-ancestors 'self'/);
  const csp = s.split('\n').find(l => /^\s*add_header Content-Security-Policy/.test(l));
  assert.ok(csp, 'the snippet sets its own CSP');
  assert.doesNotMatch(csp, /'unsafe-eval'/, "only 'wasm-unsafe-eval' was measured to be needed");
  assert.match(csp, /'wasm-unsafe-eval'/);
});

test('the pm2 app binds to localhost only, under /sales-app', () => {
  const cfg = require(path.join(REPO, 'deploy', 'sales-app.ecosystem.config.js')).apps[0];
  const args = cfg.args.join(' ');
  assert.equal(cfg.name, 'sales-app');
  assert.match(args, /--server\.address 127\.0\.0\.1/);
  assert.match(args, /--server\.baseUrlPath sales-app/);
  const main = read(REPO, 'deploy', 'ecosystem.config.js');
  assert.ok(!main.includes('sales-app'), 'must stay out of the main ecosystem (CI deploys reload it)');
});
