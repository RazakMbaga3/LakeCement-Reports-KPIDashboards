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

/* ─── Helpers ────────────────────────────────────────────── */
function padMo(mo) { return String(mo).padStart(2, '0'); }
function daysInMonth(yr, mo) { return new Date(+yr, +mo, 0).getDate(); }

function kpiSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

/* Month column index in the 19-col table: Jan=6, Feb=7 … Dec=17 (0-based) */
function moToColIdx(mo) { return mo + 5; }

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
  if (isNaN(target) || isNaN(actual)) return;

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
  row.className           = row.className.replace(/\b(achieved|not-achieved)-row\b/g, '')
                            + ' ' + (achieved ? 'achieved' : 'not-achieved') + '-row';

  // Bubble up to filter summary
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

    const colIdx = getColIndex(cell);
    const cellMo = colIdx >= 6 ? colIdx - 5 : mo;  // derive month from column

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
          await NyatiAPI.setOverride(slug, yr, cellMo, num, reason);
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

    localStorage.setItem(manualKey(dept, slug, yr, cellMo), val);

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
        await _kpiPut(dept, yr, cellMo, [{ kpi_key: slug, target: isNaN(target) ? null : target, actual, unit }]);
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
  let results;
  try {
    results = await NyatiAPI.evalFormulas(yr, mo);
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
      cells[3].textContent = Number(r.target).toLocaleString('en-US');
    }
    if (r.signage && cells[2] && r.signage !== cells[2].textContent.trim()) {
      cells[2].textContent = r.signage;
    }

    if (r.value == null) return;
    const displayVal = Number(r.value).toLocaleString('en-US');

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

/* ─── Load manually saved values ──────────────────────────
   Batches one GET per dept-section (not per row) against the backend KPI
   API; falls back to the existing per-row localStorage read if that dept's
   fetch fails (offline / server unreachable). ────────────────────────── */
async function loadManualValues(mo, yr) {
  const rows = Array.from(document.querySelectorAll('.kpi-table .data-row'));

  // Collect distinct depts present on the page, fetch each dept's KPI rows once.
  const depts = [...new Set(rows.map(row => {
    const section = row.closest('.dept-section');
    return section ? section.id.replace('dept-', '') : 'unknown';
  }))];

  const deptMaps = {};
  await Promise.all(depts.map(async dept => {
    try {
      const kpis = await _kpiGet(dept, yr, mo);
      deptMaps[dept] = new Map(kpis.map(k => [k.kpi_key, k]));
    } catch (e) {
      deptMaps[dept] = null; // signals "use localStorage fallback for this dept"
    }
  }));

  rows.forEach(row => {
    const labelCell = row.querySelector('td');
    if (!labelCell) return;
    const section = row.closest('.dept-section');
    const dept    = section ? section.id.replace('dept-', '') : 'unknown';
    const slug    = kpiSlug(labelCell.textContent.trim());
    const map     = deptMaps[dept];

    const cells = row.querySelectorAll('td');

    // ACTUAL column (col 4) — use selected month key
    const serverRow = map ? map.get(slug) : undefined;
    const actVal = map
      ? (serverRow && serverRow.actual != null ? String(serverRow.actual) : null)
      : localStorage.getItem(manualKey(dept, slug, yr, mo));
    if (actVal !== null && !cells[4]?.classList.contains('auto-cell')) {
      if (cells[4]) cells[4].textContent = actVal;
    }

    // Monthly columns (cols 6–17) — edits to any of these still sync to
    // the server (see makeEditable's commit() below, keyed by that cell's
    // own month), but this load only prefetches the selected month (one
    // GET per dept instead of twelve); the other 11 still read their
    // last-known value from the localStorage cache until re-edited or the
    // month is selected directly.
    for (let m = 1; m <= 12; m++) {
      const colIdx = moToColIdx(m);
      const cell   = cells[colIdx];
      if (!cell) continue;
      if (cell.classList.contains('auto-cell') || cell.classList.contains('edited-cell')) continue;
      const saved = localStorage.getItem(manualKey(dept, slug, yr, m));
      if (saved !== null) cell.textContent = saved;
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
  const yr   =  document.getElementById('year-select').value;
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

    // Current value: server first, then localStorage manual
    let currentVal = cells[4].textContent.trim();
    if (serverMap && serverMap.has(slug)) {
      const serverVal = serverMap.get(slug).actual;
      if (serverVal != null) currentVal = String(serverVal);
    } else {
      const stored = localStorage.getItem(manualKey(dept, slug, yr, mo));
      if (stored !== null) currentVal = stored;
    }

    const badge = isAuto ? '<span class="modal-auto-badge">⚡ auto — override via the table cell</span>' : '';

    tableRows += `
      <tr>
        <td class="modal-kpi-label">${label}</td>
        <td><input class="modal-input" type="text"
            data-slug="${slug}" data-mo="${mo}" data-yr="${yr}" data-dept="${dept}"
            data-is-auto="${isAuto}" data-target="${target}" data-unit="${unit}"
            value="${currentVal}" placeholder="—" ${isAuto ? 'disabled' : ''} />${badge}</td>
        <td class="modal-unit">${unit}</td>
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
            <tr><th>KPI</th><th>Value</th><th>Unit</th></tr>
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
  const inputs = document.querySelectorAll('.modal-input');
  let dept = null, yr = null, mo = null;
  const kpis = []; // batched for a single PUT to the backend

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

    if (val === '' || val === '—') return;
    if (isAuto) return; // formula-layer rows change only via the audited override flow
    if (typeof canFillKPIDept === 'function' && !canFillKPIDept(rowDept)) return;

    // Local write stays as the offline fallback cache, unchanged.
    localStorage.setItem(manualKey(rowDept, slug, rowYr, rowMo), val);

    const actual = parseFloat(val.replace(/,/g, ''));
    if (!isNaN(actual)) {
      kpis.push({ kpi_key: slug, target: isNaN(target) ? null : target, actual, unit });
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

/* ─── INIT ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  attachInlineEditing();
});
