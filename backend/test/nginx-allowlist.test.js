/*
  test/nginx-allowlist.test.js — proves deploy/nginx-public-allowlist.conf
  serves the frontend and nothing else from the web root.

  The web root on the droplet is the git checkout, so on 2026-10-12 nginx
  was serving backend/.env, .git/ and backend/data/mis/employees.json to
  anyone. The allowlist is two regex locations that 404 everything that is
  not a page, script, stylesheet or image under the root, forms/ or vendor/.
  This test reads those two patterns out of the real config file (so a
  later edit is what gets tested) and checks them against:
    - a hand-written table of paths that must be served or refused, and
    - every file tracked in git: exactly the frontend's assets are public.

  It emulates nginx's rule for these locations: a request is refused when
  any of the patterns matches the (already decoded, slash-merged) URI.
  `~*` locations are case-insensitive, `~` ones are not.

  Pure static check: no server, no Postgres, no nginx.
  Usage: node --test test/nginx-allowlist.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const CONF = path.join(REPO, 'deploy', 'nginx-public-allowlist.conf');

function denyPatterns() {
  const src = fs.readFileSync(CONF, 'utf8');
  const out = [];
  const re = /^\s*location\s+(~\*?)\s+(\S+)\s*\{\s*\n\s*return\s+404;/gm;
  let m;
  while ((m = re.exec(src))) out.push(new RegExp(m[2], m[1] === '~*' ? 'i' : ''));
  return out;
}

const PATTERNS = denyPatterns();
const refused = (uri) => PATTERNS.some(p => p.test(uri));

const WEB_EXT = /\.(?:html|js|css|png|jpe?g|gif|svg|ico|webp|woff2?)$/i;
const isPublicAsset = (rel) =>
  (/^[^/]+$/.test(rel) || /^(forms|vendor)\//.test(rel)) && WEB_EXT.test(rel);

test('the config file still holds exactly the two deny patterns', () => {
  assert.equal(PATTERNS.length, 2, 'expected two `location ~ … { return 404; }` blocks');
});

test('secrets, source and business files are refused', () => {
  for (const uri of [
    '/backend/.env', '/.env', '/.git/config', '/.git/HEAD', '/.gitignore',
    '/backend/data/mis/employees.json', '/backend/data/mis/compliance-certs.json',
    '/backend/routes/auth.js', '/backend/server.js', '/backend/node_modules/pg/package.json',
    '/BACKEND/.env', '/README.md', '/LCL_Access_Matrix_2026.xlsx',
    '/1. Production Report 21.04.2026 (1).xlsx', '/LIMESTONE % daily report.pdf',
    '/generate_access_matrix.py', '/run.bat', '/docs/pm/RAID_LOG.md',
    '/deploy/deploy.sh', '/deploy/Production Report 01.07.2026.xlsx',
    '/e2e/fixtures/roles.js', '/node_modules/x/index.js', '/scripts/x.js',
    '/data/samples/2026-04-21/x.xlsx', '/master stoppage reports/a.xlsx',
    '/backups/lcl_mis-2026-10-12-0230.dump', '/backend/logs/app.log',
    '/vendor/xlsx-0.18.5/LICENSE', '/forms/notes.md', '/forms/.env',
    '/1. Compliance Master.xlsx', '/AppData/Local/x.html',
    // Integration Package: the collaborator's code, its Odoo password (.env)
    // and Streamlit password hashes (users.toml) live in the checkout.
    '/integration/sales-dashboard/.env', '/integration/sales-dashboard/users.toml',
    '/integration/sales-dashboard/app.py', '/integration/sales-dashboard/web_extract.py',
    '/integration/sales-dashboard/outbox/Salesperson Matrix.xlsx',
    '/integration/sales-dashboard/.venv/bin/python',
  ]) {
    assert.ok(refused(uri), `must be refused: ${uri}`);
  }
});

test('the frontend, the API and certbot challenges are served', () => {
  for (const uri of [
    '/', '/login.html', '/index.html', '/auth.js', '/styles.css', '/favicon.png',
    '/NYATI-LOGO.png', '/forms/dispatch-form.html', '/forms/api-client.js',
    '/forms/forms.css', '/vendor/xlsx-0.18.5/xlsx.full.min.js',
    '/api/health', '/api/mis/monthly/export.xlsx', '/api/compliance/items/12',
    '/api/compliance/documents/3/download', '/.well-known/acme-challenge/abc123',
    '/sale-register.html', '/dispatch.html',
  ]) {
    assert.ok(!refused(uri), `must be served: ${uri}`);
  }
});

test('both site configs include the allowlist straight after `root`', () => {
  for (const name of ['nginx.digitalocean.conf', 'nginx.conf']) {
    const lines = fs.readFileSync(path.join(REPO, 'deploy', name), 'utf8')
      .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const i = lines.findIndex(l => /^root\s/.test(l));
    assert.ok(i >= 0, `${name}: no root line`);
    assert.match(lines[i + 1], /^include\s+\S*lcl-public-allowlist\.conf;$/,
      `${name}: the line after root must include the allowlist (it must precede every regex location)`);
  }
});

test('of every tracked file, exactly the frontend assets are public', (t) => {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch {
    t.skip('git not available');
    return;
  }
  const wrong = files.filter(rel => refused('/' + rel) === isPublicAsset(rel));
  assert.deepEqual(wrong, [], 'served/refused disagrees with the allowlist intent');
});

/* /sales-app/ is a top-level directory, so the allowlist alone 404s it; it is
   reached only because deploy/nginx-sales-app.conf matches it first with a
   `^~` prefix location (checked in integration-package-static.test.js). */
test('the allowlist by itself refuses /sales-app/ — the ^~ location is what opens it', () => {
  assert.ok(refused('/sales-app/'));
  assert.ok(refused('/sales-app/_stcore/health'));
});

test('the production template includes the sales-app snippet right after the allowlist', () => {
  const lines = fs.readFileSync(path.join(REPO, 'deploy', 'nginx.digitalocean.conf'), 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const i = lines.findIndex(l => /lcl-public-allowlist\.conf;$/.test(l));
  assert.match(lines[i + 1], /^include\s+\S*lcl-sales-app\.conf;$/);
});
