/* ══════════════════════════════════════════════════════════════
   Lake Cement Ltd – Monthly KPI Data Engine
   Auto-aggregation from daily forms + inline/modal editing
   ══════════════════════════════════════════════════════════════ */

/* ─── Auto-calc row definitions ─────────────────────────────
   Each entry maps a KPI row (by exact label text) to a daily
   form field. Cells with these labels get ⚡ treatment.
─────────────────────────────────────────────────────────────── */
const KPI_AUTO = [
  // ── Quality form ────────────────────────────────────────────
  {
    label: 'Clinker Free Lime',
    form:  'quality',
    field: 'free_lime',
    agg:   'avg',
    dp:    1,
  },
  // ── Dispatch form ────────────────────────────────────────────
  {
    label: 'Despatch / Day',
    form:  'dispatch',
    field: '__dispatch_total',   // synthetic — summed in getMonthEntries
    agg:   'avg',
    dp:    0,
  },
  // ── Kiln form ────────────────────────────────────────────────
  {
    label: 'Kiln Output',
    form:  'kiln',
    field: 'kiln_prod_mt',
    agg:   'avg',
    dp:    0,
  },
  {
    label:   'Specific Thermal Energy Consumption',
    form:    'kiln',
    // Weighted average: ∑(coal×NCV×1000) / ∑(prod)
    compute: function(entries) {
      var heatSum = 0, prodSum = 0;
      entries.forEach(function(d) {
        var prod = parseFloat(d.kiln_prod_mt);
        var coal = parseFloat(d.kiln_coal_cons);
        var ncv  = parseFloat(d.kiln_coal_ncv);
        if (prod > 0 && coal > 0 && ncv > 0) {
          heatSum += coal * ncv * 1000;
          prodSum += prod;
        }
      });
      return prodSum > 0 ? parseFloat((heatSum / prodSum).toFixed(0)) : null;
    },
    dp: 0,
  },
  // ── Power form ───────────────────────────────────────────────
  {
    label:   'Specific Power Consumption – Total',
    form:    'power-cons',
    compute: function(entries) {
      var kwhFields = ['pwr_crusher_kwh','pwr_rawmill_kwh','pwr_coalmill_kwh','pwr_kiln_kwh',
                       'pwr_cm2_kwh','pwr_packing_kwh','pwr_utils_kwh','pwr_lighting_kwh'];
      var kwhSum = 0, prodSum = 0;
      entries.forEach(function(d) {
        var prod = (parseFloat(d.pwr_kiln_prod_mt) || 0) + (parseFloat(d.pwr_cm2_prod_mt) || 0);
        if (prod > 0) {
          kwhSum  += kwhFields.reduce(function(s, f) { return s + (parseFloat(d[f]) || 0); }, 0);
          prodSum += prod;
        }
      });
      return prodSum > 0 ? parseFloat((kwhSum / prodSum).toFixed(2)) : null;
    },
    dp: 2,
  },
  {
    label:   'Specific Power Consumption – Up to Clinker',
    form:    'power-cons',
    compute: function(entries) {
      var kwhFields = ['pwr_crusher_kwh','pwr_rawmill_kwh','pwr_coalmill_kwh','pwr_kiln_kwh'];
      var kwhSum = 0, prodSum = 0;
      entries.forEach(function(d) {
        var prod = parseFloat(d.pwr_kiln_prod_mt) || 0;
        if (prod > 0) {
          kwhSum  += kwhFields.reduce(function(s, f) { return s + (parseFloat(d[f]) || 0); }, 0);
          prodSum += prod;
        }
      });
      return prodSum > 0 ? parseFloat((kwhSum / prodSum).toFixed(2)) : null;
    },
    dp: 2,
  },
  {
    label:   'Specific Power Consumption – Cement Grinding',
    form:    'power-cons',
    compute: function(entries) {
      var kwhSum = 0, prodSum = 0;
      entries.forEach(function(d) {
        var prod = parseFloat(d.pwr_cm2_prod_mt) || 0;
        if (prod > 0) {
          kwhSum  += parseFloat(d.pwr_cm2_kwh) || 0;
          prodSum += prod;
        }
      });
      return prodSum > 0 ? parseFloat((kwhSum / prodSum).toFixed(2)) : null;
    },
    dp: 2,
  },
];

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

function _withDispatchTotal(formId, data) {
  if (formId === 'dispatch') {
    const tot = ['dispatch_425r','dispatch_425n','dispatch_bulker','dispatch_bigbag']
      .reduce((s, f) => s + (parseFloat(data[f]) || 0), 0);
    data.__dispatch_total = tot;
  }
  return data;
}

/* Collect a form's daily entries for a given month — server first (source
   of truth), localStorage scan as fallback (offline / server unreachable). */
async function getMonthEntries(formId, year, month) {
  if (window.NyatiAPI) {
    try {
      const from = `${year}-${padMo(month)}-01`;
      const to   = `${year}-${padMo(month)}-${padMo(daysInMonth(year, month))}`;
      const records = await window.NyatiAPI.getFormRange(formId, from, to);
      return records.map(r => _withDispatchTotal(formId, r.data ?? {}));
    } catch (e) {
      // fall through to localStorage scan below
    }
  }

  const prefix  = `nyati-${formId}-${year}-${padMo(month)}-`;
  const entries = [];
  for (let d = 1; d <= 31; d++) {
    const raw = localStorage.getItem(prefix + String(d).padStart(2, '0'));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      entries.push(_withDispatchTotal(formId, parsed.data ?? {}));
    } catch { /* skip corrupt entries */ }
  }
  return entries;
}

function aggregateField(entries, field, agg, dp) {
  const vals = entries.map(e => parseFloat(e[field])).filter(v => !isNaN(v) && v > 0);
  if (!vals.length) return null;
  let result;
  if (agg === 'sum') result = vals.reduce((a, b) => a + b, 0);
  else               result = vals.reduce((a, b) => a + b, 0) / vals.length;
  return parseFloat(result.toFixed(dp ?? 2));
}

/* ─── Cell column helpers ────────────────────────────────── */
const EDITABLE_COL_MIN = 4;   // 0-based: col 4 = ACTUAL
const EDITABLE_COL_MAX = 17;  // col 17 = Dec (0-based index in a 19-col table)
const SKIP_COLS = new Set([1, 2, 3, 18]); // unit, sign, target, status

function getColIndex(cell) {
  return Array.from(cell.parentElement.children).indexOf(cell);
}

/* Month column index in the 19-col table: Jan=6, Feb=7 … Dec=17 (0-based) */
function moToColIdx(mo) { return mo + 5; }

/* ─── Storage keys ───────────────────────────────────────── */
function manualKey(dept, slug, yr, mo) {
  return `nyati-kpi-${dept}-${slug}-${yr}-${padMo(mo)}`;
}
function overrideKey(dept, slug, yr, mo) {
  return `nyati-kpi-override-${dept}-${slug}-${yr}-${padMo(mo)}`;
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
      // Override: store separately, swap badge
      localStorage.setItem(overrideKey(dept, slug, yr, cellMo), val);
      cell.classList.remove('auto-cell');
      cell.classList.add('edited-cell');
    } else {
      localStorage.setItem(manualKey(dept, slug, yr, cellMo), val);
    }

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

/* Normalize dashes so HTML en/em-dash (&ndash; &mdash;) match JS string literals */
function normLabel(s) {
  return s.replace(/[–—]/g, '–').trim();
}

/* ─── Load auto-calculated values ────────────────────────── */
async function loadAutoCalcValues(mo, yr) {
  for (const { label, form, field, agg, dp, compute } of KPI_AUTO) {
    const entries = await getMonthEntries(form, yr, mo);
    const value   = compute
      ? compute(entries)
      : aggregateField(entries, field, agg, dp);
    if (value === null) continue;

    const normTarget = normLabel(label);

    document.querySelectorAll('.kpi-table .data-row').forEach(row => {
      const labelCell = row.querySelector('td');
      if (!labelCell) return;
      if (normLabel(labelCell.textContent) !== normTarget) return;

      const section = row.closest('.dept-section');
      const dept    = section ? section.id.replace('dept-', '') : 'unknown';
      const slug    = kpiSlug(label);

      // Skip if a manual override exists
      const ovKey = overrideKey(dept, slug, yr, mo);
      if (localStorage.getItem(ovKey) !== null) {
        const actualCell = row.querySelectorAll('td')[4];
        if (actualCell) {
          actualCell.textContent = localStorage.getItem(ovKey);
          actualCell.classList.add('edited-cell');
        }
        const moCell = row.querySelectorAll('td')[moToColIdx(mo)];
        if (moCell) {
          moCell.textContent = localStorage.getItem(ovKey);
          moCell.classList.add('edited-cell');
        }
        return;
      }

      const displayVal = value.toLocaleString('en-US');

      // Fill ACTUAL column (index 4)
      const actualCell = row.querySelectorAll('td')[4];
      if (actualCell) {
        actualCell.textContent = displayVal;
        actualCell.classList.add('auto-cell');
        actualCell.classList.remove('edited-cell');
        updateRowStatus(row);
      }

      // Fill the matching monthly column
      const moCell = row.querySelectorAll('td')[moToColIdx(mo)];
      if (moCell) {
        moCell.textContent = displayVal;
        moCell.classList.add('auto-cell');
        moCell.classList.remove('edited-cell');
      }
    });
  }
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

  // Build modal HTML
  const autoLabels = new Set(KPI_AUTO.map(k => k.label));

  let tableRows = '';
  rows.forEach(row => {
    const cells   = row.querySelectorAll('td');
    if (cells.length < 5) return;
    const label   = cells[0].textContent.trim();
    const unit    = cells[1].textContent.trim();
    const target  = cells[3].textContent.trim();
    const slug    = kpiSlug(label);
    const isAuto  = autoLabels.has(label);

    // Current value: server first, then localStorage manual/override
    let currentVal = cells[4].textContent.trim();
    if (serverMap && serverMap.has(slug)) {
      const serverVal = serverMap.get(slug).actual;
      if (serverVal != null) currentVal = String(serverVal);
    } else {
      const stored   = localStorage.getItem(manualKey(dept, slug, yr, mo));
      const override = localStorage.getItem(overrideKey(dept, slug, yr, mo));
      if (stored !== null)   currentVal = stored;
      if (override !== null) currentVal = override;
    }

    const badge = isAuto ? '<span class="modal-auto-badge">⚡ auto</span>' : '';

    tableRows += `
      <tr>
        <td class="modal-kpi-label">${label}</td>
        <td><input class="modal-input" type="text"
            data-slug="${slug}" data-mo="${mo}" data-yr="${yr}" data-dept="${dept}"
            data-is-auto="${isAuto}" data-target="${target}" data-unit="${unit}"
            value="${currentVal}" placeholder="—" />${badge}</td>
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
    if (typeof canFillKPIDept === 'function' && !canFillKPIDept(rowDept)) return;

    // Local write stays as the offline fallback cache, unchanged.
    if (isAuto) {
      localStorage.setItem(overrideKey(rowDept, slug, rowYr, rowMo), val);
    } else {
      localStorage.setItem(manualKey(rowDept, slug, rowYr, rowMo), val);
    }

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
