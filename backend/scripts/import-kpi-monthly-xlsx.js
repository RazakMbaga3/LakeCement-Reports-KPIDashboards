/*
  scripts/import-kpi-monthly-xlsx.js — seed kpi_monthly straight from the
  plant's "M - 11 LCL Department KPI Report" workbooks.

  Supersedes scripts/import-kpi-monthly.js, which read pre-extracted JSON
  produced by a one-off Python/openpyxl script. Reading the .xlsx directly
  removes that intermediate (and the Python dependency), so re-seeding after
  a new monthly report arrives is one command.

  WHAT IT READS — and why it is more than the old importer got:
  each sheet has the per-KPI columns (KPI | UNIT | SIGNAGE | TARGET |
  Current month ACTUAL | REMARKS) followed by a twelve-column "Full year KPI
  Tracker" (Jan…Dec). The old extractor took only the current-month ACTUAL,
  so a June workbook yielded June alone and the Jan–May history sitting in
  the tracker was discarded — which is why kpi_monthly started at April for
  most departments. This reads every populated tracker column, so the three
  workbooks together cover Jan–June 2026.

  MERGE RULE: later workbook wins. A month appears in every workbook issued
  after it, and the later copy is the revised one. This also covers the two
  gaps in the set — the June file's Mines tracker is empty (May supplies
  Mines), and Packing's April is absent from the April and May files but
  present in June.

  Targets, units and signage are per-KPI, not per-month, so a historical
  month inherits the target from the workbook it came from. REMARKS are
  written only for a workbook's OWN month: column 5 comments on the current
  month, and attaching it to Jan–May too would be inventing commentary.

  Rows the formula engine owns (despatch-day, clinker-free-lime) are skipped
  — the dashboard renders those from /api/formula/eval, so a manual value
  would be dead data. 'Mines Workshop' (per-equipment matrix) and 'OT'
  (overtime table) do not fit kpi_monthly's (department, kpi_key) model and
  are not wired to it on the frontend; they are not imported.

  Writes directly to Postgres via backend/db, bypassing HTTP/auth — right for
  a bulk historical seed with no interactive user session. updated_by is left
  NULL, which is how the earlier backfill's rows are marked too.

  Usage:
    node scripts/import-kpi-monthly-xlsx.js --dry-run     # plan only, no writes
    node scripts/import-kpi-monthly-xlsx.js               # apply
    node scripts/import-kpi-monthly-xlsx.js --dir "<folder>"
*/
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const fs   = require('fs');
const XLSX = require('xlsx');
const db   = require('../db');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'Pl. upload all the KPI reports in dash board (1)');

/* filename → the month that workbook is FOR. Order matters: later wins. */
const FILES = [
  ['M - 11 LCL Department KPI Report - April 2026.xlsx', 2026, 4],
  ['M - 11 LCL Department KPI Report - May  2026.xlsx',  2026, 5],
  ['M - 11 LCL Department KPI Report - Jun 2026.xlsx',   2026, 6],
];

/* Months some workbook in the set is FOR — their figures come from that
   workbook's full-precision ACTUAL column, never from a tracker copy. */
const OWNED_MONTHS = new Set(FILES.map(f => f[2]));

const SHEET_TO_DEPT = {
  'Mechanical': 'mechanical', 'Production': 'production', 'E & I': 'ei',
  'Power Plant': 'powerplant', 'Mines': 'mines', 'Packing Plant': 'packing',
  'Stores': 'stores',
};

const MONTH_COLS = { Jan: 1, Feb: 2, Mar: 3, April: 4, May: 5, June: 6,
                     July: 7, Aug: 8, Sept: 9, Oct: 10, Nov: 11, Dec: 12 };

const FORMULA_OWNED = new Set(['despatch-day', 'clinker-free-lime']);

/* The workbook misspells two labels the dashboard spells correctly. Alias to
   the dashboard's slug rather than mint a key kpiSlug(label) never matches. */
const KEY_ALIASES = {
  'powerplant|auxillary-power-cons': 'auxiliary-power-consumption',
  'powerplant|unplanned-stop-in-a-year-cummulative': 'unplanned-stop-in-a-year-cumulative',
};

/* Same slug function kpi-data.js uses to match a table row. */
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (['', '-', '–', '—', 'NIL', 'Nil', 'N/A', '#DIV/0!'].includes(s)) return null;
  s = s.replace(/,/g, '').replace(/%/g, '').replace(/\+/g, '');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}
const txt    = v => (v == null ? null : (String(v).trim() || null));
const remark = v => { const s = txt(v); return s && !['-', '–', '—'].includes(s) ? s : null; };
const blank  = v => v == null || (typeof v === 'string' && v.trim() === '');

function extract(dir) {
  const rows = [];
  const missing = [];
  for (const [fname, year, ownMonth] of FILES) {
    const full = path.join(dir, fname);
    if (!fs.existsSync(full)) { missing.push(fname); continue; }
    const wb = XLSX.readFile(full, { cellDates: true });

    for (const [sheet, dept] of Object.entries(SHEET_TO_DEPT)) {
      if (!wb.Sheets[sheet]) { console.warn(`  ! ${fname}: sheet "${sheet}" missing`); continue; }
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: null, blankrows: true });

      /* The header row is not at a fixed index — Stores starts one row lower. */
      const hdrIdx = grid.findIndex(r => String((r && r[0]) || '').trim().toUpperCase() === 'KPI');
      if (hdrIdx < 0) { console.warn(`  ! ${fname} / ${sheet}: no KPI header row`); continue; }
      const head = grid[hdrIdx].map(c => String(c || '').trim());

      const trackerCol = {};
      for (const [name, m] of Object.entries(MONTH_COLS)) {
        const i = head.indexOf(name);
        if (i >= 0) trackerCol[m] = i;
      }

      for (let i = hdrIdx + 1; i < grid.length; i++) {
        const r = grid[i] || [];
        const label = String(r[0] || '').trim();
        if (!label) continue;
        const unitRaw = r[1], signRaw = r[2], targetRaw = r[3], actualRaw = r[4], remarkRaw = r[5];
        /* Section headers ("HEALTH & SAFETY") carry a label and nothing else. */
        if (blank(unitRaw) && blank(signRaw) && blank(targetRaw) && blank(actualRaw)) continue;
        const U = label.toUpperCase();
        if (U === 'LAKE CEMENT LIMITED' || U === 'KPI') continue;
        if (U.startsWith('DEPARTMENT') || U.startsWith('RESPONSIBILITY') || U.startsWith('MONTHLY KEY')) continue;

        let key = slug(label);
        if (!key || FORMULA_OWNED.has(key)) continue;
        key = KEY_ALIASES[dept + '|' + key] || key;

        const unit   = (txt(unitRaw) || '').slice(0, 20);   // kpi_monthly.unit is VARCHAR(20)
        const target = num(targetRaw);

        /* A month's OWN workbook is the authority for it: the "Current month
           ACTUAL" cell carries the computed figure at full precision
           (1572.1286816439422), while the tracker column beside it holds the
           rounded display value a later workbook copied forward (93.56
           becomes 93.6). Taking the tracker for a month some workbook owns
           would quietly round 73 already-stored figures. So:
             · own month  → the ACTUAL column
             · any other  → the tracker, which is the only source for the
                            months no workbook in this set is for (Jan–Mar) */
        const ownActual = num(actualRaw);
        if (ownActual !== null) {
          rows.push({
            department: dept, year, month: ownMonth, kpi_key: key, label, unit,
            target, actual: ownActual, remarks: remark(remarkRaw), source: fname,
          });
        }

        for (const m of Object.keys(trackerCol)) {
          const month = Number(m);
          if (OWNED_MONTHS.has(month)) continue;   // its own workbook is better
          const actual = num(r[trackerCol[m]]);
          if (actual === null) continue;
          rows.push({
            department: dept, year, month, kpi_key: key, label, unit, target, actual,
            /* Column 5 comments on the workbook's current month only —
               attaching it to a back-month would be inventing commentary. */
            remarks: null,
            source: fname + ' (tracker)',
          });
        }
      }
    }
  }
  if (missing.length) {
    console.error('Missing workbook(s):\n  ' + missing.join('\n  '));
    process.exit(1);
  }
  return rows;
}

/* Every key must match a row on index.html, or the value lands where no
   screen can show it — exactly how kpi_monthly ended up with an orphan
   'limestone-production' row. backend/test/kpi-keys.test.js fails the build
   on such a row, so catch it here first, before writing.

   Mirrors kpi-data.js's own resolution: an explicit data-kpi-key on the <tr>
   wins, otherwise the slug of the row label. */
function pageKeysByDept() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const secRe = /<section[^>]*class="[^"]*dept-section[^"]*"[^>]*id="dept-([a-z]+)"[^>]*>/g;
  const marks = [];
  let m;
  while ((m = secRe.exec(html))) marks.push({ dept: m[1], start: m.index });
  marks.forEach((sec, i) => { sec.end = i + 1 < marks.length ? marks[i + 1].start : html.length; });

  const out = {};
  for (const sec of marks) {
    const body = html.slice(sec.start, sec.end);
    const trs = body.match(/<tr[^>]*class="[^"]*data-row[^"]*"[^>]*>[\s\S]*?<\/tr>/g) || [];
    out[sec.dept] = new Set(trs.map(t => {
      const pinned = t.match(/<tr[^>]* data-kpi-key="([^"]+)"/);
      if (pinned) return pinned[1];
      const td = (t.match(/<td[^>]*>[\s\S]*?<\/td>/) || [''])[0];
      return slug(td.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    }));
  }
  return out;
}

/* Later workbook wins for the same (dept, year, month, key). */
function dedupe(rows) {
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.department}|${r.year}|${r.month}|${r.kpi_key}`, r);
  return [...byKey.values()];
}


/* ── Remote seeding over the API ───────────────────────────────────
   The droplet is managed by someone else, so `npm run seed:kpi` cannot
   always be run where the production database lives. It does not need to be:
   PUT /api/kpi/:dept/:year/:month performs the same upsert, and admin or
   management may write any department (config/kpiAccess.js). So the same
   figures can be seeded from anywhere with an admin login over HTTPS.

   One request per (department, month) — 42 of them for six months across
   seven departments, each well inside the route's 500-row cap. Each is
   transactional server-side and leaves a KPI_UPDATE audit row naming the
   keys, attributed to whoever ran it. */
async function apiLogin(base, username, password) {
  const res = await fetch(base.replace(/\/$/, '') + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login failed (${res.status}): ${body.error || 'no message'}`);
  if (body.mustChangePassword) {
    throw new Error('this account must change its password before it can be used');
  }
  return body.token;
}

async function apiSeed(base, token, rows, { verifyOnly } = {}) {
  const root = base.replace(/\/$/, '') + '/api/kpi';
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  /* group by dept + period — one call each */
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.department}|${r.year}|${r.month}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const round3 = n => (n === null || n === undefined ? null : Math.round(Number(n) * 1000) / 1000);
  let sent = 0, failed = 0, missing = 0, mismatched = 0;

  for (const [k, batch] of [...groups.entries()].sort()) {
    const [dept, year, month] = k.split('|');
    const url = `${root}/${dept}/${year}/${month}`;

    if (!verifyOnly) {
      const payload = batch.map(r => ({
        kpi_key: r.kpi_key, target: r.target, actual: r.actual,
        unit: r.unit || '', ...(r.remarks ? { remarks: r.remarks } : {}),
      }));
      const res = await fetch(url, { method: 'PUT', headers: auth, body: JSON.stringify(payload) });
      if (!res.ok) {
        const b = await res.text();
        console.error(`  x PUT ${dept} ${year}-${month}: ${res.status} ${b.slice(0, 160)}`);
        failed++;
        continue;
      }
      sent += batch.length;
    }

    /* Read it back — the same check --verify makes against the local DB. */
    const got = await fetch(url, { headers: auth });
    if (!got.ok) { console.error(`  x GET ${dept} ${year}-${month}: ${got.status}`); failed++; continue; }
    const stored = new Map((await got.json()).map(r => [r.kpi_key, r]));
    for (const r of batch) {
      const s = stored.get(r.kpi_key);
      if (!s) { console.error(`  ! missing after write: ${dept} ${year}-${month} ${r.kpi_key}`); missing++; continue; }
      if (round3(s.actual) !== round3(r.actual)) {
        console.error(`  ! mismatch: ${dept} ${year}-${month} ${r.kpi_key} — remote ${s.actual} vs workbook ${round3(r.actual)}`);
        mismatched++;
      }
    }
    process.stdout.write(`  ${verifyOnly ? 'checked' : 'seeded '} ${dept.padEnd(11)} ${year}-${String(month).padStart(2, '0')}  ${String(batch.length).padStart(2)} rows\n`);
  }

  console.log(`\n${verifyOnly ? '' : `sent ${sent} rows · `}failed calls ${failed} · missing ${missing} · mismatched ${mismatched}`);
  const clean = !failed && !missing && !mismatched;
  console.log(clean ? 'OK - the remote matches the workbooks exactly.' : 'DISCREPANCIES (see above).');
  return clean;
}

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');
  const argOf  = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const apiBase = argOf('--api');
  const dirArg = args.indexOf('--dir');
  const dir    = dirArg >= 0 ? args[dirArg + 1] : DEFAULT_DIR;

  console.log(`Reading workbooks from:\n  ${dir}\n`);
  const rows = dedupe(extract(dir));

  const periods = [...new Set(rows.map(r => `${r.year}-${String(r.month).padStart(2, '0')}`))].sort();
  const depts   = [...new Set(rows.map(r => r.department))].sort();
  console.log(`${rows.length} rows · ${depts.length} departments · ${periods.length} months (${periods[0]} … ${periods[periods.length - 1]})\n`);

  const grid = {};
  for (const r of rows) {
    const p = `${r.year}-${String(r.month).padStart(2, '0')}`;
    (grid[r.department] = grid[r.department] || {})[p] = (grid[r.department][p] || 0) + 1;
  }
  console.log('rows per department per month');
  console.log('  ' + 'dept'.padEnd(13) + periods.map(p => p.slice(5).padStart(3)).join(' '));
  for (const d of depts) {
    console.log('  ' + d.padEnd(13) + periods.map(p => String(grid[d][p] || '·').padStart(3)).join(' '));
  }

  /* Pre-flight: a key with no row on index.html would be stored invisibly. */
  const pageKeys = pageKeysByDept();
  const unmapped = {};
  for (const r of rows) {
    const keys = pageKeys[r.department];
    if (!keys || !keys.has(r.kpi_key)) {
      (unmapped[r.department] = unmapped[r.department] || new Map()).set(r.kpi_key, r.label);
    }
  }
  const badDepts = Object.keys(unmapped);
  if (badDepts.length) {
    console.error('\nREFUSING TO WRITE - these keys have no matching row on index.html, so the');
    console.error('values would be invisible on the dashboard (and would fail kpi-keys.test.js):');
    for (const d of badDepts) {
      console.error('  ' + d + ':');
      for (const [k, label] of unmapped[d]) console.error(`     ${k}   ("${label}")`);
    }
    console.error('\nFix by adding data-kpi-key="<key>" to the matching <tr class="data-row">');
    console.error('in index.html, or by adding a KEY_ALIASES entry above.');
    process.exit(1);
  }
  console.log('\nkey check: all ' + new Set(rows.map(r => r.department + '|' + r.kpi_key)).size +
              ' (department, key) pairs match a row on index.html');

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    process.exit(0);
  }

  /* --api: seed a REMOTE instance over HTTPS instead of the local database,
     for when the droplet is managed by someone else. Same figures, same
     upsert, through PUT /api/kpi/:dept/:year/:month. */
  if (apiBase) {
    const user = argOf('--user') || process.env.KPI_SEED_USER;
    const pass = argOf('--password') || process.env.KPI_SEED_PASSWORD;
    if (!user || !pass) {
      console.error('--api needs --user and --password (or KPI_SEED_USER / KPI_SEED_PASSWORD).');
      console.error('The account must be admin or management - those are the roles that may');
      console.error('write every department (backend/config/kpiAccess.js).');
      process.exit(1);
    }
    console.log(`${verify ? 'Verifying' : 'Seeding'} ${apiBase} as ${user}`);
    let token;
    try {
      token = await apiLogin(apiBase, user, pass);
    } catch (e) {
      console.error('  ' + e.message);
      process.exit(1);
    }
    const clean = await apiSeed(apiBase, token, rows, { verifyOnly: verify });
    process.exit(clean ? 0 : 1);
  }


  /* --verify: re-read the workbooks and check every figure against what is
     actually stored, in both directions. Comparison is at the column's own
     precision — kpi_monthly.actual is NUMERIC(12,3), so a workbook value of
     1572.1286816439422 is stored as 1572.129 and a raw comparison would
     report a false mismatch on almost every computed KPI. */
  if (verify) {
    const round3 = n => (n === null || n === undefined ? null : Math.round(Number(n) * 1000) / 1000);
    const lo = Math.min(...rows.map(r => r.year * 100 + r.month));
    const hi = Math.max(...rows.map(r => r.year * 100 + r.month));
    const stored = await db.query(
      `SELECT department, year, month, kpi_key, target, actual
       FROM kpi_monthly WHERE (year * 100 + month) BETWEEN $1 AND $2`, [lo, hi]);
    const storedMap = new Map(stored.rows.map(r => [`${r.department}|${r.year}|${r.month}|${r.kpi_key}`, r]));

    const missing = [], mismatch = [];
    for (const r of rows) {
      const k = `${r.department}|${r.year}|${r.month}|${r.kpi_key}`;
      const s = storedMap.get(k);
      if (!s) { missing.push(k); continue; }
      if (round3(s.actual) !== round3(r.actual)) {
        mismatch.push(`${k}  actual: stored ${s.actual} vs workbook ${round3(r.actual)}`);
      }
      if (r.target !== null && round3(s.target) !== round3(r.target)) {
        mismatch.push(`${k}  target: stored ${s.target} vs workbook ${round3(r.target)}`);
      }
    }

    /* The other direction: a stored row in this period that no workbook
       accounts for. Not automatically wrong — the earlier backfill folded
       text-status KPIs ("AS PER FREQUENCY") into remarks with no numeric
       actual, and those legitimately have no workbook figure — but it is
       exactly where foreign or stale data would hide, so it gets listed. */
    const extracted = new Set(rows.map(r => `${r.department}|${r.year}|${r.month}|${r.kpi_key}`));
    const extra = stored.rows
      .filter(s => !extracted.has(`${s.department}|${s.year}|${s.month}|${s.kpi_key}`))
      .map(s => `${s.department} ${s.year}-${String(s.month).padStart(2, '0')} ${s.kpi_key}  (actual=${s.actual})`);

    console.log(`\nVERIFY - ${rows.length} workbook figures vs ${stored.rows.length} stored rows in ${lo}..${hi}`);
    console.log(`  missing from the database:      ${missing.length}`);
    missing.forEach(k => console.log('     ' + k));
    console.log(`  value mismatches:               ${mismatch.length}`);
    mismatch.forEach(k => console.log('     ' + k));
    console.log(`  stored but in no workbook:      ${extra.length}`);
    extra.forEach(k => console.log('     ' + k));

    const clean = !missing.length && !mismatch.length;
    console.log('\n' + (clean ? 'OK - every workbook figure is stored exactly as given.'
                              : 'DISCREPANCIES FOUND (see above).'));
    process.exit(clean ? 0 : 1);
  }


  let upserted = 0, failed = 0;
  for (const r of rows) {
    try {
      await db.query(`
        INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, remarks, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (department, year, month, kpi_key)
        DO UPDATE SET target  = COALESCE(EXCLUDED.target, kpi_monthly.target),
                      actual  = EXCLUDED.actual,
                      unit    = CASE WHEN EXCLUDED.unit = '' THEN kpi_monthly.unit ELSE EXCLUDED.unit END,
                      remarks = COALESCE(EXCLUDED.remarks, kpi_monthly.remarks),
                      updated_at = NOW()
      `, [r.department, r.year, r.month, r.kpi_key, r.target, r.actual, r.unit, r.remarks]);
      upserted++;
    } catch (e) {
      failed++;
      console.error(`  x ${r.department} ${r.year}-${r.month} ${r.kpi_key}: ${e.message}`);
    }
  }
  console.log(`\nupserted ${upserted}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
