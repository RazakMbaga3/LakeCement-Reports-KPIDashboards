/* ══════════════════════════════════════════════════════════════
   Lake Cement Ltd – Monthly KPI Data Engine
   Auto-aggregation from daily forms + inline/modal editing
   ══════════════════════════════════════════════════════════════ */

/* ─── Auto-calculated KPI values ────────────────────────────
   NO FORMULA MATH LIVES HERE. Every computed KPI is defined once in
   forms/formula-registry.js and evaluated server-side by
   backend/services/formulaEngine.js; this file only renders what
   GET /api/formula/eval/:year/:month returns (values, targets,
   override flags). Rows are matched by kpiSlug(label) === result.key.
─────────────────────────────────────────────────────────────── */

/* ─── Backend KPI API helpers ────────────────────────────── */
function _kpiApiBase() { return (typeof _API_BASE !== 'undefined') ? _API_BASE : 'http://localhost:5000/api'; }
function _kpiHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const token = (typeof getAuthToken === 'function') ? getAuthToken() : null;
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}
/* GET current target/actual/unit for every kpi_key in a dept/month — used
   to prefer server values over localStorage without one call per row. */
async function _kpiGet(dept, yr, mo) {
  const res = await fetch(`${_kpiApiBase()}/kpi/${dept}/${yr}/${mo}`, { headers: _kpiHeaders() });
  if (!res.ok) throw new Error('kpi GET failed: ' + res.status);
  return res.json(); // array of {kpi_key, target, actual, unit}
}
/* PUT one or more {kpi_key,target,actual,unit} rows — server upserts. */
async function _kpiPut(dept, yr, mo, kpis) {
  const res = await fetch(`${_kpiApiBase()}/kpi/${dept}/${yr}/${mo}`, {
    method: 'PUT', headers: _kpiHeaders(), body: JSON.stringify(kpis),
  });
  if (!res.ok) throw new Error('kpi PUT failed: ' + res.status);
  return res.json();
}
/* GET a whole fiscal year (April fyStartYear → March fyStartYear+1) for one
   dept in a single call — powers the 12-column month tracker without one
   request per month. Mirrors backend/routes/kpi.js's /fiscal/:dept/:year. */
async function _kpiGetFiscalYear(dept, fyStartYear) {
  const res = await fetch(`${_kpiApiBase()}/kpi/fiscal/${dept}/${fyStartYear}`, { headers: _kpiHeaders() });
  if (!res.ok) throw new Error('kpi fiscal GET failed: ' + res.status);
  return res.json(); // array of {year, month, kpi_key, target, actual, unit, remarks}
}

/* ─── Helpers ────────────────────────────────────────────── */
function padMo(mo) { return String(mo).padStart(2, '0'); }
function daysInMonth(yr, mo) { return new Date(+yr, +mo, 0).getDate(); }

function kpiSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* Display formatting for KPI numbers — kpi_monthly.target/actual are
   NUMERIC(12,3), so raw values print with 3 decimals (e.g. "103.040");
   one decimal is plenty of precision for this dashboard's KPIs. */
function fmtNum(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/* (Client-side month aggregation removed — the formula engine on the
   server is the only place KPI math happens. See loadAutoCalcValues.) */

/* ─── Cell column helpers ────────────────────────────────── */
const EDITABLE_COL_MIN = 4;   // 0-based: col 4 = ACTUAL
const EDITABLE_COL_MAX = 17;  // col 17 = Dec (0-based index in a 19-col table)
const SKIP_COLS = new Set([1, 2, 3, 18]); // unit, sign, target, status

function getColIndex(cell) {
  return Array.from(cell.parentElement.children).indexOf(cell);
}

/* Month column index in the 19-col table. Columns are physically ordered
   April..March (fiscal year, see index.html) — col 6 = April … col 17 =
   March, so a calendar month maps through its fiscal position first
   (calMonthToFiscalPos, defined in app.js which loads before this file). */
function moToColIdx(mo) { return 6 + calMonthToFiscalPos(mo); }

/* ─── Storage keys ───────────────────────────────────────────
   (manual values only — overrides of computed KPIs live server-side
   in kpi_overrides, audited, with a mandatory reason) */
function manualKey(dept, slug, yr, mo) {
  return `nyati-kpi-${dept}-${slug}-${yr}-${padMo(mo)}`;
}

/* ─── Row status auto-update ─────────────────────────────── */
function updateRowStatus(row) {
  const cells  = row.querySelectorAll('td');
  if (cells.length < 19) return;
  const sign   = cells[2].textContent.trim();
  const target = parseFloat(cells[3].textContent.replace(/,/g, ''));
  const actual = parseFloat(cells[4].textContent.replace(/,/g, ''));

  if (isNaN(actual)) {
    // No real value at all for this period — don't leave a stale
    // Achieved/Not-Achieved verdict (or hardcoded figure) on screen from
    // a previous month.
    markRowNoData(row);
    return;
  }
  if (isNaN(target)) {
    // A real computed/entered value exists, but this KPI has no fixed
    // target by design (e.g. despatch-day, total-power-kwh carry
    // target:null in the registry) — show the value with no
    // achieved/not-achieved judgment, rather than treating it as "no data".
    const statusCell = cells[18];
    statusCell.textContent = '—';
    statusCell.className   = 'status';
    cells[4].className     = 'actual';
    row.className = row.className.replace(/\b(achieved|not-achieved|no-data)-row\b/g, '');
    if (typeof updateSummary === 'function') updateSummary();
    return;
  }

  let achieved = false;
  if (sign === '<')  achieved = actual < target;
  if (sign === '>')  achieved = actual > target;
  if (sign === '<=') achieved = actual <= target;
  if (sign === '>=') achieved = actual >= target;
  if (sign === '=')  achieved = actual === target;

  const statusCell = cells[18];
  statusCell.textContent  = achieved ? 'Achieved' : 'Not Achieved';
  statusCell.className    = 'status ' + (achieved ? 'achieved-tag' : 'not-tag');
  cells[4].className      = 'actual ' + (achieved ? 'green' : 'red');
  row.className           = row.className.replace(/\b(achieved|not-achieved|no-data)-row\b/g, '')
                            + ' ' + (achieved ? 'achieved' : 'not-achieved') + '-row';

  // Bubble up to filter summary
  if (typeof updateSummary === 'function') updateSummary();
}

/* ─── "No data submitted" state ──────────────────────────────
   Previously a row with no real value for the selected period silently
   kept whatever Achieved/Not-Achieved verdict (and ACTUAL figure) was
   last hardcoded or rendered for a different month — indistinguishable
   from a genuinely current, genuinely achieved KPI. Any code path that
   determines "no value exists for this month" must route through here
   instead of leaving the cell/row alone. */
function markRowNoData(row) {
  const cells = row.querySelectorAll('td');
  if (cells.length < 19) return;
  const statusCell = cells[18];
  statusCell.textContent = 'No data';
  statusCell.className   = 'status no-data-tag';
  cells[4].className     = 'actual no-data';
  cells[4].textContent   = '—';
  row.className = row.className.replace(/\b(achieved|not-achieved|no-data)-row\b/g, '') + ' no-data-row';
  if (typeof updateSummary === 'function') updateSummary();
}

/* ─── Inline editing ─────────────────────────────────────── */
function makeEditable(cell, dept, slug, yr, mo, isAutoCell) {
  if (cell.dataset.editing) return;
  cell.dataset.editing = '1';
  cell.contentEditable = 'true';
  cell.classList.add('cell-editing');

  // Select all text
  const range = document.createRange();
  range.selectNodeContents(cell);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  async function commit() {
    delete cell.dataset.editing;
    cell.contentEditable = 'false';
    cell.classList.remove('cell-editing');

    const val = cell.textContent.trim();
    if (val === '') return;

    // `yr` (from year-select) is the FISCAL year's start year — resolve
    // the REAL calendar month/year this cell represents before touching
    // any API or storage key. Clicking a tracker column (colIdx 6-17)
    // means its physical fiscal position IS the position; clicking the
    // ACTUAL column (colIdx 4) means "the currently selected month", so
    // derive its fiscal position from `mo` instead.
    const colIdx = getColIndex(cell);
    const fiscalPos = (colIdx >= 6 && colIdx <= 17) ? (colIdx - 6) : calMonthToFiscalPos(mo);
    const cellMo = fiscalPosToCalMonth(fiscalPos);
    const cellYr = fiscalPosToCalYear(fiscalPos, yr);

    if (isAutoCell) {
      // Auto-calculated value → server-side audited override, reason mandatory
      const num = parseFloat(val.replace(/,/g, ''));
      const reason = isNaN(num) ? '' :
        (prompt('This value is auto-calculated from daily reports.\n' +
                'Overriding it is recorded permanently with your name.\n\n' +
                'Reason for the override (required, min 5 characters):') || '').trim();
      if (isNaN(num) || reason.length < 5) {
        alert('Override cancelled — a numeric value and a reason (min 5 characters) are required.');
      } else {
        try {
          await NyatiAPI.setOverride(slug, cellYr, cellMo, num, reason);
        } catch (e) {
          alert(e && e.status === 403
            ? 'You do not have permission to override KPI values (admin/MD only).'
            : 'Override failed — server unreachable or rejected it.');
        }
      }
      // Re-render from the formula layer either way (revert or show flag)
      loadKpiData(+document.getElementById('month-select').value,
                  document.getElementById('year-select').value);
      return;
    }

    localStorage.setItem(manualKey(dept, slug, cellYr, cellMo), val);

    // If this is the ACTUAL column, update row status
    if (colIdx === 4) updateRowStatus(cell.parentElement);

    // Sync to the backend KPI store — read target/unit from this row so
    // the upsert doesn't null them out (local write above already
    // guarantees the value isn't lost if this fails).
    const rowCells = cell.parentElement.querySelectorAll('td');
    const unit     = rowCells[1]?.textContent.trim() || '';
    const target   = parseFloat(rowCells[3]?.textContent.replace(/,/g, ''));
    const actual   = parseFloat(val.replace(/,/g, ''));
    if (!isNaN(actual)) {
      try {
        await _kpiPut(dept, cellYr, cellMo, [{ kpi_key: slug, target: isNaN(target) ? null : target, actual, unit }]);
      } catch (e) { /* local value already saved above; not blocking the user */ }
    }
  }

  cell.addEventListener('blur',    commit, { once: true });
  cell.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); cell.blur(); }
    if (e.key === 'Escape') {
      delete cell.dataset.editing;
      cell.contentEditable = 'false';
      cell.classList.remove('cell-editing');
      cell.removeEventListener('blur', commit);
    }
  }, { once: true });
}

/* Attach click-to-edit to all kpi-table cells */
function attachInlineEditing() {
  document.querySelectorAll('.kpi-table').forEach(tbl => {
    tbl.addEventListener('click', e => {
      const cell = e.target.closest('td');
      if (!cell) return;
      const row = cell.closest('tr');
      if (!row || !row.classList.contains('data-row')) return;

      const colIdx = getColIndex(cell);
      if (colIdx < EDITABLE_COL_MIN || colIdx > EDITABLE_COL_MAX) return;
      if (SKIP_COLS.has(colIdx)) return;

      // Derive dept from the section element's id
      const section = tbl.closest('.dept-section');
      const dept    = section ? section.id.replace('dept-', '') : 'unknown';
      const slug    = kpiSlug(row.querySelector('td')?.textContent ?? '');
      const yr      = document.getElementById('year-select').value;
      const mo      = +document.getElementById('month-select').value;

      makeEditable(cell, dept, slug, yr, mo, cell.classList.contains('auto-cell'));
    });
  });
}

/* Set of formula keys seen in the last eval — used by the modal and the
   inline editor to know which rows are auto/override-gated. */
window._nyAutoKeys = window._nyAutoKeys || new Set();

/* ─── Load auto-calculated values from the formula layer ──────
   One GET returns every KPI: computed value, active override (with
   who/why — shown as a tooltip on the flagged cell), and the target
   from the registry (single source of truth — overwrites whatever
   the HTML table had hardcoded). Offline: cells keep whatever
   loadManualValues restores; no client-side math. */
async function loadAutoCalcValues(mo, yr) {
  if (!window.NyatiAPI || !NyatiAPI.evalFormulas) return;
  // `yr` is the fiscal year's start year — the formula engine (daily_reports
  // aggregation) wants a real calendar year, resolved via `mo`'s fiscal
  // position (see app.js's calMonthToFiscalPos/fiscalPosToCalYear).
  const calYear = fiscalPosToCalYear(calMonthToFiscalPos(mo), yr);
  let results;
  try {
    results = await NyatiAPI.evalFormulas(calYear, mo);
  } catch (e) {
    return; // offline / server unreachable — manual cached values still load
  }

  const byKey = new Map(results.map(r => [r.key, r]));
  window._nyAutoKeys = new Set(results.map(r => r.key));

  document.querySelectorAll('.kpi-table .data-row').forEach(row => {
    const labelCell = row.querySelector('td');
    if (!labelCell) return;
    const r = byKey.get(kpiSlug(labelCell.textContent));
    if (!r) return;

    const cells = row.querySelectorAll('td');

    // Registry target overrides the hardcoded table cell
    if (r.target != null && cells[3]) {
      cells[3].textContent = fmtNum(r.target);
    }
    if (r.signage && cells[2] && r.signage !== cells[2].textContent.trim()) {
      cells[2].textContent = r.signage;
    }

    if (r.value == null) return;
    const displayVal = fmtNum(r.value);

    [cells[4], cells[moToColIdx(mo)]].forEach(cell => {
      if (!cell) return;
      cell.textContent = displayVal;
      cell.classList.toggle('auto-cell',   !r.overridden);
      cell.classList.toggle('edited-cell', !!r.overridden);
      if (r.overridden && r.override) {
        cell.title = 'Manual override by ' + (r.override.by || 'unknown') +
          ' on ' + String(r.override.at).slice(0, 10) + ': ' + r.override.reason +
          '  (formula value: ' + (r.computed == null ? '—' : r.computed) + ')';
      } else {
        cell.removeAttribute('title');
      }
    });
    updateRowStatus(row);
  });
}

/* ─── Executive Summary hero cards ────────────────────────────
   Previously every .sk-card on the Plant Summary tab was static HTML with
   four hardcoded data-daily/month/ytd/full values baked in at authoring
   time — selecting a different month changed which of those four canned
   numbers showed, never a real figure. Cards tagged data-formula-key now
   render exclusively from GET /api/formula/eval/:year/:month, the same
   endpoint the department tables use. evalMonth() only computes a
   month aggregate, so Today/Full-Year views show the month figure with a
   note rather than inventing a daily/annual number the engine doesn't
   produce. Cards with no data-formula-key (Equipment Reliability, Safety,
   etc.) have no formula-registry KPI behind them yet — left alone here,
   marked .sk-illustrative in the HTML instead. */
function signageAchieved(signage, actual, target) {
  if (signage === '<')  return actual < target;
  if (signage === '>')  return actual > target;
  if (signage === '<=') return actual <= target;
  if (signage === '>=') return actual >= target;
  if (signage === '=')  return actual === target;
  return null; // no signage — no achieved/not-achieved judgment to make
}

async function loadHeroCards(mo, yr, view) {
  const cards = Array.from(document.querySelectorAll('.sk-card[data-formula-key]'));
  if (!cards.length) return;

  if (!window.NyatiAPI || !NyatiAPI.evalFormulas) {
    cards.forEach(markHeroCardUnavailable);
    return;
  }

  // `yr` is the fiscal year's start year — resolve the real calendar year
  // `mo` falls in (see loadAutoCalcValues for the same pattern).
  const calYear = fiscalPosToCalYear(calMonthToFiscalPos(mo), yr);
  let results;
  try {
    results = await NyatiAPI.evalFormulas(calYear, mo);
  } catch (e) {
    cards.forEach(markHeroCardUnavailable); // offline / server unreachable
    return;
  }

  const byKey = new Map(results.map(r => [r.key, r]));
  const isMonthView = (view === 'month' || view === undefined);

  cards.forEach(card => {
    const r = byKey.get(card.dataset.formulaKey);
    const valueEl = card.querySelector('.sk-value');
    const barEl   = card.querySelector('.sk-bar-fill');
    const tgtEl   = card.querySelector('.sk-tgt');
    const pctEl   = card.querySelector('.sk-pct');
    const statusEl = card.querySelector('.sk-status');
    const dotSpan  = statusEl ? statusEl.querySelector('.sk-status-dot') : null;

    if (!r || r.value == null) {
      if (valueEl) valueEl.textContent = '—';
      if (barEl) barEl.style.width = '0%';
      if (tgtEl) tgtEl.textContent = 'No data for this period';
      if (pctEl) pctEl.textContent = '—';
      if (statusEl) {
        statusEl.innerHTML = '';
        if (dotSpan) statusEl.appendChild(dotSpan);
        statusEl.append(' No data submitted for ' + MONTHS[mo] + ' ' + calYear);
      }
      card.classList.remove('on-track', 'watch', 'concern');
      return;
    }

    const displayVal = fmtNum(r.value);
    if (valueEl) valueEl.textContent = displayVal;

    const note = isMonthView ? '' : ' (shown: ' + MONTHS[mo] + ' ' + calYear + ' — daily/full-year not computed)';

    if (r.target == null) {
      // No fixed target by design (target:null in the registry) — show the
      // real value with no achieved/not-achieved judgment.
      if (barEl) barEl.style.width = '100%';
      if (tgtEl) tgtEl.textContent = 'No fixed target' + note;
      if (pctEl) pctEl.textContent = '—';
      if (statusEl) {
        statusEl.innerHTML = '';
        if (dotSpan) statusEl.appendChild(dotSpan);
        statusEl.append(' Informational — no target set');
      }
      card.classList.remove('on-track', 'watch', 'concern');
      return;
    }

    const achieved = signageAchieved(r.signage, r.value, r.target);
    const pct = r.target !== 0 ? (r.value / r.target) * 100 : 0;

    if (tgtEl) tgtEl.textContent = (r.targetLabel || ('Target ' + r.signage + ' ' + r.target)) + note;
    if (pctEl) pctEl.textContent = pct.toFixed(1) + '%';
    if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%';

    card.classList.remove('on-track', 'watch', 'concern');
    card.classList.add(achieved ? 'on-track' : 'concern');
    if (statusEl) {
      statusEl.innerHTML = '';
      if (dotSpan) statusEl.appendChild(dotSpan);
      statusEl.append(' ' + (achieved ? 'On Track' : 'Concern') +
        (r.overridden ? ' (manually overridden)' : ''));
    }
    if (r.overridden && r.override) {
      card.title = 'Manual override by ' + (r.override.by || 'unknown') +
        ' on ' + String(r.override.at).slice(0, 10) + ': ' + r.override.reason +
        '  (formula value: ' + (r.computed == null ? '—' : r.computed) + ')';
    } else {
      card.removeAttribute('title');
    }
  });
}

function markHeroCardUnavailable(card) {
  const valueEl = card.querySelector('.sk-value');
  const statusEl = card.querySelector('.sk-status');
  const dotSpan  = statusEl ? statusEl.querySelector('.sk-status-dot') : null;
  if (valueEl) valueEl.textContent = '—';
  if (statusEl) {
    statusEl.innerHTML = '';
    if (dotSpan) statusEl.appendChild(dotSpan);
    statusEl.append(' Server unreachable');
  }
  card.classList.remove('on-track', 'watch', 'concern');
}

/* ─── Load manually saved values ──────────────────────────
   Batches two GETs per dept-section (not per row, not per month): the
   selected month's values (for the ACTUAL + REMARKS columns) and the
   whole fiscal year in one call (for the 12-column month tracker).
   Previously the tracker columns were localStorage-only — real data
   imported straight into Postgres (e.g. the Excel backfill) never touched
   a browser's localStorage, so those columns silently stayed blank or
   showed stale leftover test values under the wrong month. The server is
   now the source of truth for all 13 cells; localStorage is only a
   fallback if a fetch fails outright (offline). ────────────────────── */
async function loadManualValues(mo, yr) {
  // Mines Workshop's .data-row markup is a per-equipment TARGET/ACTUAL
  // matrix (up to 23 <td>s: label/unit/sign, then TARGET/ACTUAL pairs per
  // machine) — it doesn't share the standard 19-col single-KPI layout every
  // other dept uses, has no kpi_monthly rows behind it (not backfilled,
  // see extract-kpi-monthly.py), and its column 4/5/18 mean something
  // completely different there. Running this pipeline on it blanked real
  // hardcoded ACTUAL figures to "—" and mangled unrelated TARGET cells, so
  // it's excluded outright rather than guessing from cell count.
  const rows = Array.from(document.querySelectorAll('.kpi-table .data-row'))
    .filter(row => row.closest('.dept-section')?.id !== 'dept-minesworkshop');

  // `yr` (year-select) is the FISCAL year's start year — resolve the real
  // calendar year `mo` falls in for the single-month fetch/fallback keys.
  const calYear = fiscalPosToCalYear(calMonthToFiscalPos(mo), yr);

  // Collect distinct depts present on the page, fetch each dept's KPI rows once.
  const depts = [...new Set(rows.map(row => {
    const section = row.closest('.dept-section');
    return section ? section.id.replace('dept-', '') : 'unknown';
  }))];

  const deptMaps = {};      // selected month only — ACTUAL + REMARKS columns
  const deptYearMaps = {};  // whole fiscal year, keyed "slug|fiscalPos" — tracker columns
  await Promise.all(depts.map(async dept => {
    try {
      const kpis = await _kpiGet(dept, calYear, mo);
      deptMaps[dept] = new Map(kpis.map(k => [k.kpi_key, k]));
    } catch (e) {
      deptMaps[dept] = null; // signals "use localStorage fallback for this dept"
    }
    try {
      const fyRows = await _kpiGetFiscalYear(dept, yr);
      const m = new Map();
      fyRows.forEach(r => m.set(`${r.kpi_key}|${calMonthToFiscalPos(r.month)}`, r));
      deptYearMaps[dept] = m;
    } catch (e) {
      deptYearMaps[dept] = null; // signals "use localStorage fallback for the tracker cols"
    }
  }));

  rows.forEach(row => {
    const labelCell = row.querySelector('td');
    if (!labelCell) return;
    const section = row.closest('.dept-section');
    const dept    = section ? section.id.replace('dept-', '') : 'unknown';
    const slug    = kpiSlug(labelCell.textContent.trim());
    const map     = deptMaps[dept];
    const yearMap = deptYearMaps[dept];

    const cells = row.querySelectorAll('td');
    const actualCell = cells[4];
    if (actualCell?.classList.contains('auto-cell')) return; // formula layer owns this cell

    // ACTUAL column (col 4) — use selected month key. `map` present but with
    // no matching row (or offline with nothing in localStorage) means there
    // is genuinely no recorded value for this dept/KPI/month — that must be
    // shown as "no data", not left as whatever a previous month or the
    // original hardcoded HTML happened to contain.
    const serverRow = map ? map.get(slug) : undefined;
    const actVal = map
      ? (serverRow && serverRow.actual != null ? fmtNum(serverRow.actual) : null)
      : localStorage.getItem(manualKey(dept, slug, calYear, mo));

    if (actVal !== null) {
      if (actualCell) actualCell.textContent = actVal;
      updateRowStatus(row); // recompute Achieved/Not-Achieved against the real value just loaded
    } else {
      markRowNoData(row);
    }

    // REMARKS column (col 5) — server value for the selected month only;
    // no localStorage fallback exists for remarks (never was editable before
    // this wiring), so offline just leaves whatever text is already in the
    // cell rather than blanking real hardcoded remarks. Guarded to the
    // standard 19-col layout like updateRowStatus/markRowNoData — Mines
    // Workshop's per-equipment matrix reuses .data-row with a different
    // column meaning at index 5 (another equipment's TARGET, not remarks).
    if (cells.length >= 19) {
      const remarkCell = cells[5];
      if (remarkCell && map) {
        const remarkText = serverRow && serverRow.remarks ? serverRow.remarks : '';
        remarkCell.textContent = remarkText;
        remarkCell.classList.toggle('remark-cell', true);
      }
    }

    // Monthly tracker columns (cols 6–17, physically ordered April..March —
    // see index.html) — server-sourced from the single whole-fiscal-year
    // fetch above; falls back to localStorage per-cell only if that fetch
    // failed outright (offline). A column with no real row either way is
    // shown as "—", not left blank/stale.
    for (let fp = 0; fp <= 11; fp++) {
      const colIdx = 6 + fp;
      const cell   = cells[colIdx];
      if (!cell) continue;
      if (cell.classList.contains('auto-cell') || cell.classList.contains('edited-cell')) continue;
      if (yearMap) {
        const r = yearMap.get(`${slug}|${fp}`);
        cell.textContent = (r && r.actual != null) ? fmtNum(r.actual) : '—';
      } else {
        const cMo = fiscalPosToCalMonth(fp);
        const cYr = fiscalPosToCalYear(fp, yr);
        const saved = localStorage.getItem(manualKey(dept, slug, cYr, cMo));
        cell.textContent = saved !== null ? saved : '—';
      }
    }
  });
}

/* ─── Public entry point called from applyFilters() ─────── */
async function loadKpiData(mo, yr) {
  await loadAutoCalcValues(mo, yr);
  await loadManualValues(mo, yr);
}

/* ══════════════════════════════════════════════════════════
   FILL MONTHLY DATA MODAL
══════════════════════════════════════════════════════════ */
async function openMonthlyModal() {
  const mo   = +document.getElementById('month-select').value;
  // year-select holds the fiscal year's start year — resolve the real
  // calendar year `mo` belongs to before hitting kpi_monthly with it.
  const fyYr = document.getElementById('year-select').value;
  const yr   = fiscalPosToCalYear(calMonthToFiscalPos(mo), fyYr);
  const dept =  typeof currentDept !== 'undefined' ? currentDept : 'summary';

  // Defense in depth: the Fill button is hidden when the role can't edit
  // the current dept, but refuse here too in case this is ever called
  // directly (stale DOM state, console call, etc.).
  if (typeof canFillKPIDept === 'function' && !canFillKPIDept(dept)) {
    if (typeof showPermDenied === 'function') {
      showPermDenied('You do not have edit access for this department.');
    }
    return;
  }

  // Mines Workshop's per-equipment TARGET/ACTUAL matrix doesn't fit this
  // single-KPI-per-row modal (see loadManualValues) and has no kpi_monthly
  // rows behind it — reachable only for admin/management (kpiAccess.js
  // grants them 'all' depts), so guard here too rather than presenting a
  // modal that would silently misread equipment columns as KPI value/unit.
  if (dept === 'minesworkshop') {
    alert('Mines Workshop KPIs are not editable via this form yet.');
    return;
  }

  const section = document.getElementById('dept-' + dept);
  if (!section) return;

  const MONTHS_SHORT = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Gather all data rows for this dept
  const rows = Array.from(section.querySelectorAll('.kpi-table .data-row'));
  if (!rows.length) {
    alert('No KPI rows found for this department.');
    return;
  }

  // One prefetch for the whole dept/month instead of N synchronous
  // localStorage reads per row; null on failure signals "use localStorage".
  let serverMap = null;
  try {
    const kpis = await _kpiGet(dept, yr, mo);
    serverMap = new Map(kpis.map(k => [k.kpi_key, k]));
  } catch (e) { /* fall back to localStorage below */ }

  // Build modal HTML — auto rows come from the formula layer and can only
  // be changed via the audited override flow (click the cell in the table),
  // so their inputs are disabled here.
  const autoKeys = window._nyAutoKeys || new Set();

  let tableRows = '';
  rows.forEach(row => {
    const cells   = row.querySelectorAll('td');
    if (cells.length < 5) return;
    const label   = cells[0].textContent.trim();
    const unit    = cells[1].textContent.trim();
    const target  = cells[3].textContent.trim();
    const slug    = kpiSlug(label);
    const isAuto  = autoKeys.has(slug);

    // Current value: server first, then localStorage manual. Remarks only
    // read from col 5 on the standard 19-col layout — Mines Workshop's
    // per-equipment matrix reuses .data-row with a different column 5
    // (another equipment's TARGET), same guard as loadManualValues.
    let currentVal = cells[4].textContent.trim();
    let currentRemark = (cells.length >= 19 && cells[5]) ? cells[5].textContent.trim() : '';
    if (serverMap && serverMap.has(slug)) {
      const serverRow = serverMap.get(slug);
      if (serverRow.actual != null) currentVal = String(serverRow.actual);
      if (serverRow.remarks != null) currentRemark = serverRow.remarks;
    } else {
      const stored = localStorage.getItem(manualKey(dept, slug, yr, mo));
      if (stored !== null) currentVal = stored;
    }
    if (currentRemark === '—') currentRemark = '';

    const badge = isAuto ? '<span class="modal-auto-badge">⚡ auto — override via the table cell</span>' : '';
    const escapedRemark = currentRemark.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

    tableRows += `
      <tr>
        <td class="modal-kpi-label">${label}</td>
        <td><input class="modal-input" type="text"
            data-slug="${slug}" data-mo="${mo}" data-yr="${yr}" data-dept="${dept}"
            data-is-auto="${isAuto}" data-target="${target}" data-unit="${unit}"
            value="${currentVal}" placeholder="—" ${isAuto ? 'disabled' : ''} />${badge}</td>
        <td class="modal-unit">${unit}</td>
        <td><input class="modal-input modal-remark-input" type="text"
            data-remark-for="${slug}" value="${escapedRemark}" placeholder="—" ${isAuto ? 'disabled' : ''} /></td>
      </tr>`;
  });

  const deptLabel = section.closest('.dept-section')
    ? (document.getElementById('ctx-dept-name')?.textContent ?? dept)
    : dept;

  const html = `
    <div class="kpi-modal-overlay" id="kpi-modal-overlay">
      <div class="kpi-modal" id="kpi-modal">
        <div class="kpi-modal-header">
          <div>
            <div class="kpi-modal-title">Fill Monthly Data</div>
            <div class="kpi-modal-sub">${deptLabel} — ${MONTHS_SHORT[mo]} ${yr}</div>
          </div>
          <button class="kpi-modal-close" onclick="closeMonthlyModal()">✕</button>
        </div>
        <table class="kpi-modal-table">
          <thead>
            <tr><th>KPI</th><th>Value</th><th>Unit</th><th>Remarks</th></tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
        <div class="kpi-modal-footer">
          <button class="kpi-modal-btn-save" onclick="saveAllModalValues()">Save All</button>
          <button class="kpi-modal-btn-cancel" onclick="closeMonthlyModal()">Cancel</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);

  // Close on overlay click
  document.getElementById('kpi-modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'kpi-modal-overlay') closeMonthlyModal();
  });
}

function closeMonthlyModal() {
  const overlay = document.getElementById('kpi-modal-overlay');
  if (overlay) overlay.remove();
}

async function saveAllModalValues() {
  const inputs = document.querySelectorAll('.modal-input[data-slug]');
  let dept = null, yr = null, mo = null;
  const kpis = []; // batched for a single PUT to the backend

  // Remarks live in separate inputs (data-remark-for=slug) since a KPI row's
  // value and remark are independently editable — index by slug up front.
  const remarksBySlug = {};
  document.querySelectorAll('.modal-remark-input[data-remark-for]').forEach(input => {
    remarksBySlug[input.dataset.remarkFor] = input.value.trim();
  });

  inputs.forEach(input => {
    const val    = input.value.trim();
    const slug   = input.dataset.slug;
    const rowMo  = +input.dataset.mo;
    const rowYr  = input.dataset.yr;
    const rowDept = input.dataset.dept;
    const isAuto = input.dataset.isAuto === 'true';
    const target = parseFloat(input.dataset.target.replace(/,/g, ''));
    const unit   = input.dataset.unit || '';

    dept = rowDept; yr = rowYr; mo = rowMo; // same for every row in this modal

    if (isAuto) return; // formula-layer rows change only via the audited override flow
    if (typeof canFillKPIDept === 'function' && !canFillKPIDept(rowDept)) return;

    const remark = remarksBySlug[slug] || null;

    if (val === '' || val === '—') {
      // No value entered, but a remark may still have been added/edited —
      // don't drop it silently just because the value field is empty.
      if (remark) kpis.push({ kpi_key: slug, target: isNaN(target) ? null : target, remarks: remark });
      return;
    }

    // Local write stays as the offline fallback cache, unchanged.
    localStorage.setItem(manualKey(rowDept, slug, rowYr, rowMo), val);

    const actual = parseFloat(val.replace(/,/g, ''));
    if (!isNaN(actual)) {
      kpis.push({ kpi_key: slug, target: isNaN(target) ? null : target, actual, unit, remarks: remark });
    }
  });

  closeMonthlyModal();

  if (kpis.length && dept) {
    try {
      await _kpiPut(dept, yr, mo, kpis);
    } catch (e) { /* local values already saved above; not blocking the user */ }
  }

  // Reload cells
  const selMo = +document.getElementById('month-select').value;
  const selYr =  document.getElementById('year-select').value;
  loadKpiData(selMo, selYr);
}

/* ─── Per-department completeness badge ──────────────────────
   Only departments with a verified daily-report form behind their KPIs
   are mapped here (checked against forms/formula-registry.js `form:`
   fields and backend/services/misReport.js's FORM_LABELS — not guessed).
   E&I, Mechanical, Stores and Mines Workshop have no daily_reports form
   at all (their KPIs are pure kpi_monthly manual entry), so they show no
   badge rather than a fabricated completeness figure. 'mines' form_type
   exists in the DB but isn't reliably the same thing as the Mines KPI
   department (mines-report.html, a separate TMH/weighbridge engine, does
   not write it) — left unmapped rather than assumed. */
const DEPT_FORM_MAP = {
  production: ['production', 'limestone'],
  powerplant: ['power-cons'],
  packing:    ['dispatch'],
};

async function refreshCompletenessBadge(dept, mo, yr) {
  const el = document.getElementById('ctx-completeness');
  if (!el) return;

  const formTypes = DEPT_FORM_MAP[dept];
  if (!formTypes || !window.NyatiAPI || !NyatiAPI.getCompleteness) {
    el.classList.add('hidden');
    return;
  }

  // `yr` here is the fiscal year's start year — daily_reports completeness
  // is keyed by real calendar dates, so resolve first.
  const calYear = fiscalPosToCalYear(calMonthToFiscalPos(mo), yr);
  const from = `${calYear}-${padMo(mo)}-01`;
  const to   = `${calYear}-${padMo(mo)}-${String(daysInMonth(calYear, mo)).padStart(2, '0')}`;

  let payload;
  try {
    payload = await NyatiAPI.getCompleteness(from, to);
  } catch (e) {
    el.classList.add('hidden');
    return;
  }

  const totalDays = payload.days.length;
  let coveredDays = 0;
  for (const day of payload.days) {
    const anyPresent = day.forms.some(f => formTypes.includes(f.formType) && f.present);
    if (anyPresent) coveredDays++;
  }

  const pct = totalDays > 0 ? Math.round((coveredDays / totalDays) * 100) : 0;
  const tier = pct >= 90 ? 'cc-good' : pct >= 50 ? 'cc-partial' : 'cc-poor';

  el.classList.remove('hidden', 'cc-good', 'cc-partial', 'cc-poor');
  el.classList.add(tier);
  el.innerHTML = `<span class="cc-dot"></span> ${coveredDays}/${totalDays} days submitted this month`;
}

/* ─── INIT ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  attachInlineEditing();
});
