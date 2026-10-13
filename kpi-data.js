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

/* A save that only reaches localStorage (server unreachable/rejected) must
   never look identical to a real save — other users' dashboards read from
   the server and would silently diverge from what this user believes they
   entered. Same toast style as forms/form-persist.js's _toast(). */
function _kpiToast(msg, type) {
  type = type || 'warn';
  document.getElementById('_kpt')?.remove();
  const colors = { ok: '#239557', warn: '#D97706', err: '#DC2626' };
  const icons  = { ok: '✓',       warn: '⚠',       err: '✕'      };
  const el = document.createElement('div');
  el.id = '_kpt';
  el.textContent = (icons[type] || icons.warn) + '  ' + msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '24px', right: '24px', zIndex: '9999',
    background: colors[type] || colors.warn, color: 'white',
    padding: '10px 16px', borderRadius: '8px', fontFamily: 'Inter,sans-serif',
    fontSize: '13px', fontWeight: '600', boxShadow: '0 4px 18px rgba(0,0,0,.2)',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

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
/* GET an arbitrary run of months for one dept — backs the "Last 12 Months"
   view, whose window crosses the April boundary and so cannot be answered by
   /fiscal. Mirrors backend/routes/kpi.js's /range/:dept. */
async function _kpiGetRange(dept, from, to) {
  const qs = new URLSearchParams({ from, to });
  const res = await fetch(`${_kpiApiBase()}/kpi/range/${dept}?${qs}`, { headers: _kpiHeaders() });
  if (!res.ok) throw new Error('kpi range GET failed: ' + res.status);
  return res.json(); // [{year, month, kpi_key, target, actual, unit, remarks}]
}

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

/* A KPI row binds to TWO independent key spaces, and they are not always the
   same string:

     kpiKeyOf(row)     → kpi_monthly.kpi_key — the manually entered/backfilled
                         history behind the ACTUAL, REMARKS and 12 tracker
                         columns (GET/PUT /api/kpi/:dept/:year/:month)
     formulaKeyOf(row) → forms/formula-registry.js — the server-computed value
                         and the audited override (GET /api/formula/eval)

   Both defaulted to kpiSlug(label), which made every binding hostage to the
   wording of the label:

     · the 2026-08-01 "Quarry" rename changed two Mines labels and silently
       orphaned six months of real cost data still sitting in kpi_monthly under
       mines-{maintenance,operational}-cost — those rows have read "No data"
       ever since, with nothing anywhere reporting the mismatch;
     · Power Plant's "Heat Rate" and "Auxiliary Power Consumption" rows never
       picked up the values the formula engine computes for them every day,
       because the registry calls those cpp-heat-rate / cpp-auxiliary-power.

   A row can now pin either key explicitly — data-kpi-key / data-formula-key on
   the <tr> — and the label is free to change. data-formula-key is the same
   attribute the Executive Summary's .sk-card hero cards already use.
   backend/test/kpi-keys.test.js asserts the resolution against both the stored
   keys and the registry, so a future rename fails a test, not a dashboard. */
function _rowLabelSlug(row) {
  const labelCell = row && row.querySelector ? row.querySelector('td') : null;
  return kpiSlug(labelCell ? labelCell.textContent.trim() : '');
}
function kpiKeyOf(row) {
  return (row && row.dataset && row.dataset.kpiKey) || _rowLabelSlug(row);
}
function formulaKeyOf(row) {
  return (row && row.dataset && row.dataset.formulaKey) || _rowLabelSlug(row);
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
const EDITABLE_COL_MAX = 17;  // last tracker column (TRACKER_COL_MAX, app.js)
const SKIP_COLS = new Set([1, 2, 3, 18]); // unit, sign, target, status

function getColIndex(cell) {
  return Array.from(cell.parentElement.children).indexOf(cell);
}

/* Which tracker column holds a given calendar month, or -1 when the month is
   outside the visible window. app.js owns the mapping (trackerColIndexFor)
   because it depends on the view — Apr→Mar for the fiscal views, a rolling
   12-month window for "Last 12 Months" — and the header labels, the fill and
   the inline editor must all agree on it. */
function moToColIdx(mo, calYear) { return trackerColIndexFor(calYear, mo); }

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

  /* signageAchieved() returns null when the row carries no comparison at all
     (several Quarry tonnage rows and Power Plant's Maintenance Cost have a
     target but a blank Signage cell). The five separate `if`s this replaced
     left `achieved` at its `false` initialiser in that case, so those rows
     rendered a confident "Not Achieved" against a comparison nobody had
     defined — and that verdict then fed the achievement % and the Executive
     Summary's department chips. Same helper the hero cards use. */
  const achieved = signageAchieved(sign, actual, target);

  const statusCell = cells[18];
  if (achieved === null) {
    statusCell.textContent = '—';
    statusCell.className   = 'status';
    statusCell.title       = 'No signage set for this KPI — no achieved/not-achieved judgment can be made.';
    cells[4].className     = 'actual';
    row.className = row.className.replace(/\b(achieved|not-achieved|no-data)-row\b/g, '');
    if (typeof updateSummary === 'function') updateSummary();
    return;
  }
  statusCell.removeAttribute('title');
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
function makeEditable(cell, dept, keys, yr, mo, isAutoCell) {
  const slug = keys.storeKey;
  if (cell.dataset.editing) return;
  const before = cell.textContent;   // restored if the save is refused
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

    /* Resolve the REAL calendar month/year this cell stands for before
       touching any API or storage key. A tracker column means whatever the
       active window says it means — Apr→Mar in the fiscal views, an
       arbitrary month in "Last 12 Months" — so ask app.js rather than
       assuming fiscal order. The ACTUAL column (4) is always the month
       currently selected in the filter bar. */
    const colIdx = getColIndex(cell);
    let cellMo, cellYr;
    if (colIdx >= TRACKER_COL_MIN && colIdx <= TRACKER_COL_MAX) {
      const c = trackerColumns(mo, yr)[colIdx - TRACKER_COL_MIN];
      cellMo = c.month; cellYr = c.year;
    } else {
      cellMo = mo;
      cellYr = fiscalPosToCalYear(calMonthToFiscalPos(mo), yr);
    }

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
          await NyatiAPI.setOverride(keys.formulaKey, cellYr, cellMo, num, reason);
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

    /* Column 5 is REMARKS — free text, not a number, and it belongs in
       kpi_monthly.remarks. Every non-auto cell used to fall through to the
       numeric path below, which meant a typed remark was written into the
       KPI's manual-ACTUAL localStorage cache (so it could later render as
       that KPI's value while offline) and then dropped entirely, because
       parseFloat('Kiln liner replaced') is NaN and the PUT was skipped. */
    if (colIdx === 5) {
      cell.classList.add('remark-cell');
      try {
        // An emptied remark must actually clear the stored one — see the
        // `clear` contract in backend/routes/kpi.js.
        await _kpiPut(dept, cellYr, cellMo, val === ''
          ? [{ kpi_key: slug, clear: ['remarks'] }]
          : [{ kpi_key: slug, remarks: val }]);
      } catch (e) {
        _kpiToast('Remark not saved — the server did not receive it. Retry once you’re back online.', 'err');
        cell.textContent = before;   // never leave an unsaved remark looking saved
      }
      return;
    }

    const rowCells = cell.parentElement.querySelectorAll('td');
    const unit     = rowCells[1]?.textContent.trim() || '';
    const target   = parseFloat(rowCells[3]?.textContent.replace(/,/g, ''));

    /* Emptying a value cell is a deliberate "this figure was wrong, remove
       it" — the upsert COALESCEs by default, so it needs an explicit clear
       or the bad number stays in kpi_monthly forever. */
    if (val === '') {
      localStorage.removeItem(manualKey(dept, slug, cellYr, cellMo));
      try {
        await _kpiPut(dept, cellYr, cellMo, [{ kpi_key: slug, clear: ['actual'] }]);
      } catch (e) {
        _kpiToast('Cleared on this device only — the server still holds the old value.', 'warn');
      }
      if (colIdx === 4) markRowNoData(cell.parentElement);
      else cell.textContent = '—';
      return;
    }

    const actual = parseFloat(val.replace(/,/g, ''));
    if (isNaN(actual)) {
      _kpiToast('“' + val + '” is not a number — nothing was saved.', 'err');
      loadKpiData(+document.getElementById('month-select').value,
                  document.getElementById('year-select').value);
      return;
    }

    // Local write is the offline fallback cache only; the server is the
    // source of truth every other dashboard reads.
    localStorage.setItem(manualKey(dept, slug, cellYr, cellMo), val);
    if (colIdx === 4) updateRowStatus(cell.parentElement);

    try {
      await _kpiPut(dept, cellYr, cellMo, [{ kpi_key: slug, target: isNaN(target) ? null : target, actual, unit }]);
    } catch (e) {
      // Local value already saved above (not blocking the user), but the
      // server never got it — other dashboards reading from the server
      // would silently diverge from what this user just entered.
      _kpiToast('Saved on this device only — server did not receive the update. Retry once you’re back online.', 'warn');
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
      const yr      = document.getElementById('year-select').value;
      const mo      = +document.getElementById('month-select').value;
      const isAuto  = cell.classList.contains('auto-cell');

      /* Don't open an editor for an edit the server will refuse. Two
         different permissions apply: a formula cell needs override rights
         (admin/md), a manual cell needs edit rights on this department.
         Without this a view-only role could type into any cell, and only
         find out it hadn't saved from the error toast afterwards. */
      const allowed = isAuto
        ? (typeof canOverrideKPI !== 'function' || canOverrideKPI())
        : (typeof canFillKPIDept !== 'function' || canFillKPIDept(dept));
      if (!allowed) return;

      // An override targets the FORMULA key; a manual save targets the
      // kpi_monthly key. For most rows these are the same string, but not for
      // the ones that pin one of them explicitly — see kpiKeyOf/formulaKeyOf.
      makeEditable(cell, dept, { storeKey: kpiKeyOf(row), formulaKey: formulaKeyOf(row) },
                   yr, mo, isAuto);
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
    const r = byKey.get(formulaKeyOf(row));
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

    const trackerCell = cells[moToColIdx(mo, calYear)];
    [cells[4], trackerCell].forEach(cell => {
      if (!cell) return;
      cell.textContent = displayVal;
      cell.classList.toggle('auto-cell',   !r.overridden);
      cell.classList.toggle('edited-cell', !!r.overridden);
      cell.classList.toggle('provisional-cell', !!r.provisional && !r.overridden);
      if (r.overridden && r.override) {
        cell.title = 'Manual override by ' + (r.override.by || 'unknown') +
          ' on ' + String(r.override.at).slice(0, 10) + ': ' + r.override.reason +
          '  (formula value: ' + (r.computed == null ? '—' : r.computed) + ')';
      } else if (r.provisional) {
        cell.title = '⚠ Provisional: ' + (r.provisionalNote || 'this KPI is a known-incomplete calculation.');
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

  if (!window.NyatiAPI || !NyatiAPI.evalFormulas) {
    cards.forEach(markHeroCardUnavailable);
    renderConcerns(null, mo, yr);
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
    renderConcerns(null, mo, calYear);
    return;
  }

  renderConcerns(results, mo, calYear);

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
      if (valueEl) { valueEl.textContent = '—'; valueEl.classList.add('is-empty'); }
      if (barEl) barEl.style.width = '0%';
      /* The status line below already says "No data submitted for July
         2026", which is the same fact with the month in it. Saying it
         twice per card, in two type styles, is noise — this slot holds a
         target, and there is no target to show. */
      if (tgtEl) tgtEl.textContent = '';
      if (pctEl) pctEl.textContent = '';
      if (statusEl) {
        statusEl.innerHTML = '';
        if (dotSpan) statusEl.appendChild(dotSpan);
        statusEl.append(' No data submitted for ' + MONTHS[mo] + ' ' + calYear);
      }
      /* Clearing the target left the achievement slot holding a lone "—"
         at the far end of a space-between row, with nothing opposite it:
         a dash floating in the middle of the card above an empty progress
         bar. Neither says anything the status line below does not, so the
         whole footer and the bar go with them. */
      card.classList.add('sk-nodata');
      card.classList.remove('on-track', 'watch', 'concern');
      return;
    }

    const displayVal = fmtNum(r.value);
    card.classList.remove('sk-nodata');
    if (valueEl) { valueEl.textContent = displayVal; valueEl.classList.remove('is-empty'); }

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
    card.title = r.provisional ? ('⚠ Provisional: ' + (r.provisionalNote || 'known-incomplete calculation.')) : '';
    if (statusEl) {
      statusEl.innerHTML = '';
      if (dotSpan) statusEl.appendChild(dotSpan);
      statusEl.append(' ' + (achieved ? 'On Track' : 'Concern') +
        (r.overridden ? ' (manually overridden)' : '') +
        (r.provisional ? ' ⚠ provisional' : ''));
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

/* ─── Executive Summary "Concerns" strip ──────────────────────
   Previously six spans of static text baked into index.html — they named
   specific figures ("MTBF Kiln only 45% of target (180/400 hrs)") that were
   true, at best, of one month in early 2026 and never changed again. An
   executive reading the Summary has no way to tell a frozen chip from a live
   one, so they are now derived from the same eval results the hero cards use.

   A "concern" is any KPI with a real value, a real target and a signage that
   says the value misses it. Ranked by how far short it falls (relative to
   target, so a % KPI and an MT KPI can be compared), capped so a bad month
   produces a readable strip rather than 20 chips — the same bounded-callout
   rule reliability.html's RCFA list follows. */
const CONCERN_CHIP_LIMIT = 6;

function renderConcerns(results, mo, calYear) {
  const wrap = document.getElementById('smry-alerts');
  if (!wrap) return;

  // Rebuild everything after the label, never the label itself.
  const label = wrap.querySelector('.smry-alert-label');
  wrap.innerHTML = '';
  if (label) wrap.appendChild(label);

  const chip = (text, tone) => {
    const el = document.createElement('span');
    el.className = 'smry-alert-chip' + (tone ? ' ' + tone : '');
    if (tone) {
      const dot = document.createElement('span');
      dot.className = 'alert-dot ' + tone;
      el.appendChild(dot);
    }
    el.append(' ' + text);
    wrap.appendChild(el);
    return el;
  };

  if (!results) {
    chip('Concerns unavailable — server unreachable');
    return;
  }

  const missed = results
    .filter(r => r.value != null && r.target != null &&
                 signageAchieved(r.signage, r.value, r.target) === false)
    .map(r => {
      // Relative shortfall, so KPIs in different units rank comparably.
      const gap = r.target !== 0 ? Math.abs((r.value - r.target) / r.target) * 100 : 0;
      return { ...r, gap };
    })
    .sort((a, b) => b.gap - a.gap);

  if (!missed.length) {
    /* Good news in a warning-coloured strip reads as bad news. The strip
       drops out of the alert palette entirely when there is nothing to
       alert about. */
    wrap.classList.add('is-clear');
    chip('No KPI missed its target in ' + MONTHS[mo] + ' ' + calYear, 'green');
    return;
  }
  wrap.classList.remove('is-clear');

  missed.slice(0, CONCERN_CHIP_LIMIT).forEach(r => {
    const over = r.signage === '<' || r.signage === '<=';
    const text = r.label + ' ' + fmtNum(r.value) + (r.unit ? ' ' + r.unit : '') +
      ' vs target ' + r.signage + ' ' + fmtNum(r.target) +
      ' (' + (over ? '+' : '−') + r.gap.toFixed(1) + '%)' +
      (r.provisional ? ' ⚠ provisional' : '');
    // >25% off target reads red, anything else amber — the same two tones the
    // strip already used, now earned rather than authored.
    const el = chip(text, r.gap >= 25 ? 'red' : 'orange');
    if (r.provisional) el.title = '⚠ Provisional: ' + (r.provisionalNote || 'known-incomplete calculation.');
  });

  if (missed.length > CONCERN_CHIP_LIMIT) {
    chip('+' + (missed.length - CONCERN_CHIP_LIMIT) + ' more below target');
  }
}

/* ─── Hero-card sparklines ─────────────────────────────────────
   The Executive Summary showed levels and never trend: a single month's
   figure cannot say whether a KPI is recovering or sliding, which is the
   first question anyone asks of it. One GET /api/formula/daily covers every
   KPI on the page, so this is one request, not one per card.

   Drawn as inline SVG rather than with a charting library. A sparkline is a
   polyline; Chart.js would have added 205KB of UMD to the page every manager
   opens first, taking it over its transfer budget, and would have made the
   trend depend on a CDN that a plant network may not reach. The pages with
   real charts still use Chart.js, where the bundle earns its size.

   Design notes, against the dataviz rules this repo follows:
   - ONE series, so there is no legend and no categorical hue to assign. The
     stroke is a single neutral ink for every card: status is already carried
     twice on the card (the ::before edge bar and the status dot), and
     colouring the line by status too would be a third channel for one
     dimension.
   - No axes, no grid, no point markers, no value labels. A spark answers
     which way this is going and deliberately nothing else; the exact figure
     is the large number directly above it.
   - The SVG is aria-hidden. It is decorative in the strict sense here — the
     value, target, achievement % and status are all real text in the same
     card, so a screen reader loses nothing.
   - Fewer than 3 points is not a trend: the slot is hidden rather than
     drawn, so a card never implies a shape from two dots. */
const SPARK_DAYS = 90;
const SPARK_MIN_POINTS = 3;
const SPARK_W = 100, SPARK_H = 34, SPARK_PAD = 3;

/* Sequence guard. applyFilters() fires this on every month, year and view
   change, and a fast operator can start a second run before the first await
   resolves — without this the late response of an abandoned run paints over
   the current one. Same guard, same reason, as reliability.html's _loadSeq. */
let _sparkSeq = 0;

function sparkPath(values) {
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = (max - min) || 1;               // a flat series draws a flat line, not NaN
  const innerH = SPARK_H - SPARK_PAD * 2;
  const step = values.length > 1 ? SPARK_W / (values.length - 1) : 0;
  return values.map((v, i) => {
    const x = (i * step).toFixed(2);
    const y = (SPARK_PAD + innerH - ((v - min) / span) * innerH).toFixed(2);
    return (i ? 'L' : 'M') + x + ' ' + y;
  }).join(' ');
}

async function loadSparklines(mo, yr, view) {
  const seq = ++_sparkSeq;
  const slots = Array.from(document.querySelectorAll('#dept-summary .sk-card[data-formula-key] .sk-spark'));
  if (!slots.length) return;
  if (!window.NyatiAPI || !NyatiAPI.getDailySeries) return;

  const range = reliabilityRange(mo, yr, view);
  const to = new Date(range.to + 'T00:00:00');
  const fromD = new Date(to);
  fromD.setDate(fromD.getDate() - (SPARK_DAYS - 1));
  const p2 = n => String(n).padStart(2, '0');
  const from = fromD.getFullYear() + '-' + p2(fromD.getMonth() + 1) + '-' + p2(fromD.getDate());

  let daily;
  try {
    daily = await NyatiAPI.getDailySeries(from, range.to);
  } catch (e) {
    if (seq !== _sparkSeq) return;
    slots.forEach(s => { s.style.display = 'none'; });
    return;
  }

  if (seq !== _sparkSeq) return;   // a newer run started while this one awaited

  slots.forEach(slot => {
    const card = slot.closest('.sk-card');
    const key = card && card.dataset.formulaKey;
    const entry = key && daily[key];
    const points = entry && Array.isArray(entry.series)
      ? entry.series.filter(p => p.value != null)
      : [];

    const svg = slot.querySelector('svg');
    if (!svg) return;

    if (points.length < SPARK_MIN_POINTS) {
      svg.innerHTML = '';
      slot.style.display = 'none';
      slot.removeAttribute('title');
      return;
    }
    slot.style.display = '';

    const values = points.map(p => Number(p.value));
    const d = sparkPath(values);

    /* The fill closes the same path down to the baseline. Kept very light:
       it gives the line a body to read against at 34px tall without
       competing with the figure above it. */
    const area = d + ' L' + SPARK_W + ' ' + SPARK_H + ' L0 ' + SPARK_H + ' Z';
    svg.innerHTML =
      '<path d="' + area + '" fill="currentColor" fill-opacity="0.12" stroke="none"></path>' +
      '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>';

    /* Restate the shape as text on the slot. The card's own title attribute
       is already spoken for by the override/provisional note in
       loadHeroCards, so this goes on the slot, not the card. */
    const first = values[0], last = values[values.length - 1];
    const dir = last > first ? 'rising' : last < first ? 'falling' : 'flat';
    slot.title = values.length + ' days to ' + range.to + ' — ' + dir +
                 ' (' + fmtNum(first) + ' → ' + fmtNum(last) + ')';
  });
}

/* ─── Equipment Reliability hero cards ─────────────────────────
   Fed by GET /api/insights/stoppages, which has computed availability and
   MTBF per equipment since Phase 8. Three cards on the Executive Summary
   used to carry invented figures (99.5%, 180 hrs, 98.05%) beneath a comment
   asserting that no source existed for them. It did; nothing asked for it.

   Targets are the LafargeHolcim PM Handbook v4.0 figures the reliability
   report already holds itself to — NAI >= 90%, kiln MTBF >= 500 h — kept
   here rather than in the formula registry because these are not registry
   KPIs: they are derived server-side from the stoppage matrix, not from a
   FACTS lookup. If they ever move into the registry, delete this function
   and give the cards a data-formula-key instead.

   Honesty rule: the stoppage form has had no manual entry since 2026-06-30
   (RAID I-27), so most recent months legitimately have nothing to show.
   A month with no stoppage data says so; it never falls back to a stale
   figure from a month that does have data. */
const RELIABILITY_TARGETS = {
  'kiln-availability':  { target: 90,  signage: '>=', label: 'Target ≥ 90%' },
  'plant-availability': { target: 90,  signage: '>=', label: 'Target ≥ 90%' },
  'kiln-mtbf':          { target: 500, signage: '>=', label: 'Target ≥ 500 hrs' },
};

function reliabilityRange(mo, yr, view) {
  const calYear = fiscalPosToCalYear(calMonthToFiscalPos(mo), yr);
  const p2 = n => String(n).padStart(2, '0');
  if (view === 'today') {
    const t = new Date();
    const d = t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate());
    return { from: d, to: d, label: 'today' };
  }
  if (view === 'full' || view === 'ytd') {
    // Fiscal year runs April → March.
    return { from: yr + '-04-01', to: (+yr + 1) + '-03-31', label: 'FY' + yr + '/' + ((+yr + 1) % 100) };
  }
  const last = new Date(calYear, mo + 1, 0).getDate();
  return {
    from: calYear + '-' + p2(mo + 1) + '-01',
    to:   calYear + '-' + p2(mo + 1) + '-' + p2(last),
    label: MONTHS[mo] + ' ' + calYear,
  };
}

async function loadReliabilityCards(mo, yr, view) {
  const cards = Array.from(document.querySelectorAll('.sk-card[data-insight-key]'));
  if (!cards.length) return;

  if (!window.NyatiAPI || !NyatiAPI.getStoppageInsights) {
    cards.forEach(markHeroCardUnavailable);
    return;
  }

  const range = reliabilityRange(mo, yr, view);
  let data;
  try {
    data = await NyatiAPI.getStoppageInsights(range.from, range.to);
  } catch (e) {
    cards.forEach(markHeroCardUnavailable);
    return;
  }

  const kiln = (data.equipment || []).find(x => x.key === 'kiln') || null;

  /* totalEvents === 0 means no stoppage row in the window at all. That is
     "nobody filed a stoppage report", not "the plant never stopped", and
     the two must not look alike on an executive page. */
  const noData = !data || !data.totalEvents;

  const VALUES = {
    'kiln-availability':  kiln ? kiln.availabilityPct : null,
    'kiln-mtbf':          kiln ? kiln.mtbfHours : null,
    'plant-availability': data ? data.overallAvailabilityPct : null,
  };

  cards.forEach(card => {
    const key      = card.dataset.insightKey;
    const spec     = RELIABILITY_TARGETS[key];
    const valueEl  = card.querySelector('.sk-value');
    const barEl    = card.querySelector('.sk-bar-fill');
    const tgtEl    = card.querySelector('.sk-tgt');
    const pctEl    = card.querySelector('.sk-pct');
    const statusEl = card.querySelector('.sk-status');
    const dotSpan  = statusEl ? statusEl.querySelector('.sk-status-dot') : null;
    const val      = VALUES[key];

    const setStatus = txt => {
      if (!statusEl) return;
      statusEl.innerHTML = '';
      if (dotSpan) statusEl.appendChild(dotSpan);
      statusEl.append(' ' + txt);
    };

    if (noData || val == null) {
      if (valueEl) { valueEl.textContent = '—'; valueEl.classList.add('is-empty'); }
      if (barEl) barEl.style.width = '0%';
      if (tgtEl) tgtEl.textContent = '';
      if (pctEl) pctEl.textContent = '';
      setStatus('No stoppage report filed for ' + range.label);
      card.classList.add('sk-nodata');
      card.classList.remove('on-track', 'watch', 'concern');
      return;
    }

    card.classList.remove('sk-nodata');
    if (valueEl) { valueEl.textContent = fmtNum(val); valueEl.classList.remove('is-empty'); }

    const achieved = signageAchieved(spec.signage, val, spec.target);
    const pct = spec.target !== 0 ? (val / spec.target) * 100 : 0;
    if (tgtEl) tgtEl.textContent = spec.label;
    if (pctEl) pctEl.textContent = pct.toFixed(1) + '%';
    if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
    card.classList.remove('on-track', 'watch', 'concern');
    card.classList.add(achieved ? 'on-track' : 'concern');
    setStatus((achieved ? 'On Track' : 'Concern') + ' — ' + range.label);
    card.title = 'Computed from the stoppage matrix over ' + range.from + ' .. ' + range.to +
                 ' (' + data.totalEvents + ' stoppage entries). Full detail on the Reliability report.';
  });
}


function markHeroCardUnavailable(card) {
  const valueEl = card.querySelector('.sk-value');
  const statusEl = card.querySelector('.sk-status');
  const dotSpan  = statusEl ? statusEl.querySelector('.sk-status-dot') : null;
  if (valueEl) { valueEl.textContent = '—'; valueEl.classList.add('is-empty'); }
  if (statusEl) {
    statusEl.innerHTML = '';
    if (dotSpan) statusEl.appendChild(dotSpan);
    statusEl.append(' Server unreachable');
  }
  card.classList.add('sk-nodata');
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

  /* The 12 tracker columns, as {year, month} — app.js decides whether that is
     the Apr→Mar fiscal year or a rolling 12-month window, and everything here
     follows it rather than assuming fiscal order. */
  const cols = trackerColumns(mo, yr);
  const period = c => `${c.year}-${String(c.month).padStart(2, '0')}`;

  const deptMaps = {};      // selected month only — ACTUAL + REMARKS columns
  const deptYearMaps = {};  // tracker columns, keyed "slug|YYYY-MM"
  await Promise.all(depts.map(async dept => {
    try {
      const kpis = await _kpiGet(dept, calYear, mo);
      deptMaps[dept] = new Map(kpis.map(k => [k.kpi_key, k]));
    } catch (e) {
      deptMaps[dept] = null; // signals "use localStorage fallback for this dept"
    }
    try {
      /* One request covering exactly the visible window. A rolling window
         spans two fiscal years, which /fiscal cannot answer in one call. */
      const trackerRows = await _kpiGetRange(dept, period(cols[0]), period(cols[cols.length - 1]));
      const m = new Map();
      trackerRows.forEach(r => m.set(`${r.kpi_key}|${r.year}-${String(r.month).padStart(2, '0')}`, r));
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
    const slug    = kpiKeyOf(row);
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
    for (let fp = 0; fp < cols.length; fp++) {
      const colIdx = TRACKER_COL_MIN + fp;
      const cell   = cells[colIdx];
      if (!cell) continue;
      if (cell.classList.contains('auto-cell') || cell.classList.contains('edited-cell')) continue;
      const c = cols[fp];
      if (yearMap) {
        const r = yearMap.get(`${slug}|${period(c)}`);
        cell.textContent = (r && r.actual != null) ? fmtNum(r.actual) : '—';
      } else {
        const saved = localStorage.getItem(manualKey(dept, slug, c.year, c.month));
        cell.textContent = saved !== null ? saved : '—';
      }
    }
  });
}

/* ─── Public entry point called from applyFilters() ─────── */
async function loadKpiData(mo, yr) {
  await loadAutoCalcValues(mo, yr);
  await loadManualValues(mo, yr);
  loadComplianceHints(mo, yr);   // not awaited: a hint must never delay the table
}

/* ─── Compliance Master hint on "Compliance to Legal Requirements" ──────
   Four departments report this KPI by hand. The Compliance Master knows the
   share of their tracked obligations that were not overdue at month end, so
   it is offered beside the row as a SUGGESTION — the HOD still enters the
   figure, and the monthly KPI lock is untouched. A department with no
   obligations tracked gets no hint at all: null is never shown as 0 or 100.

   The hint is a data attribute rendered by CSS ::after, NOT text in the cell:
   kpiKeyOf() derives the row's stored key from the label cell's textContent,
   so adding text there would silently re-key the row's saves. */
const _COMPLIANCE_KPI_DEPTS = {
  mines: 'compliance-to-legal-requirements', packing: 'compliance-to-legal-requirements',
  powerplant: 'compliance-to-legal-requirement', stores: 'compliance-to-legal-requirements',
};
async function loadComplianceHints(mo, yr) {
  if (!document.getElementById('_cm-hint-css')) {
    const st = document.createElement('style');
    st.id = '_cm-hint-css';
    st.textContent = 'td[data-cm-hint]::after{content:" · " attr(data-cm-hint);font-size:12px;font-weight:600;color:var(--text-muted,#5A6270);white-space:nowrap}';
    document.head.appendChild(st);
  }
  for (const [dept, key] of Object.entries(_COMPLIANCE_KPI_DEPTS)) {
    const section = document.getElementById('dept-' + dept);
    if (!section) continue;
    const row = [...section.querySelectorAll('tr.data-row')].find(r => kpiKeyOf(r) === key);
    const label = row && row.querySelector('td');
    if (!label) continue;
    delete label.dataset.cmHint;
    label.removeAttribute('title');
    try {
      const res = await fetch(`${_kpiApiBase()}/compliance/kpi-suggestion/${dept}/${yr}/${mo}`, { headers: _kpiHeaders() });
      if (!res.ok) continue;
      const s = await res.json();
      if (s.value == null) continue;
      label.dataset.cmHint = `Compliance Master: ${s.value}%`;
      label.title = `${s.compliant} of ${s.total} tracked obligations not overdue (${s.basis})` +
        (s.undated ? `; ${s.undated} have no date set and are not counted` : '') + '. A suggestion — the figure you enter is what counts.';
    } catch { /* a hint is optional */ }
  }
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
    const slug    = kpiKeyOf(row);
    const isAuto  = autoKeys.has(formulaKeyOf(row));

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

    /* Everything below is interpolated into markup, and currentVal can come
       straight out of localStorage (user-writable) — escape all of it, not
       just the remark. */
    const esc = v => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    tableRows += `
      <tr>
        <td class="modal-kpi-label">${esc(label)}</td>
        <td><input class="modal-input" type="text"
            data-slug="${esc(slug)}" data-mo="${mo}" data-yr="${yr}" data-dept="${esc(dept)}"
            data-is-auto="${isAuto}" data-target="${esc(target)}" data-unit="${esc(unit)}"
            data-original="${esc(currentVal)}"
            value="${esc(currentVal)}" placeholder="—" ${isAuto ? 'disabled' : ''} />${badge}</td>
        <td class="modal-unit">${esc(unit)}</td>
        <td><input class="modal-input modal-remark-input" type="text"
            data-remark-for="${esc(slug)}" data-original="${esc(currentRemark)}"
            value="${esc(currentRemark)}" placeholder="—" /></td>
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
    const wasBlank = ['', '—'].includes((input.dataset.original || '').trim());

    dept = rowDept; yr = rowYr; mo = rowMo; // same for every row in this modal

    if (typeof canFillKPIDept === 'function' && !canFillKPIDept(rowDept)) return;

    const remark = remarksBySlug[slug];
    const clear  = [];

    /* A formula-driven row's VALUE changes only through the audited override
       flow — but its REMARK is ordinary annotation, and an auto row (an
       overridden KPI especially) is exactly the one someone needs to explain.
       It used to be uneditable purely because the same `isAuto` flag disabled
       both inputs. */
    if (isAuto) {
      if (remark !== undefined && remark !== input.dataset.original) {
        if (remark === '') kpis.push({ kpi_key: slug, clear: ['remarks'] });
        else               kpis.push({ kpi_key: slug, remarks: remark });
      }
      return;
    }

    if (remark === '') clear.push('remarks');

    if (val === '' || val === '—') {
      /* Emptying a populated field is a deliberate correction — the upsert
         COALESCEs by default, so without an explicit clear the wrong figure
         would survive. Leaving an already-blank field blank is a no-op. */
      if (!wasBlank) clear.push('actual');
      localStorage.removeItem(manualKey(rowDept, slug, rowYr, rowMo));
      if (clear.length)               kpis.push({ kpi_key: slug, clear });
      else if (remark)                kpis.push({ kpi_key: slug, target: isNaN(target) ? null : target, remarks: remark });
      return;
    }

    const actual = parseFloat(val.replace(/,/g, ''));
    if (isNaN(actual)) {
      _kpiToast('“' + val + '” is not a number — that KPI was not saved.', 'err');
      return;
    }

    // Local write stays as the offline fallback cache, unchanged.
    localStorage.setItem(manualKey(rowDept, slug, rowYr, rowMo), val);

    const row = { kpi_key: slug, target: isNaN(target) ? null : target, actual, unit };
    if (remark)             row.remarks = remark;
    if (clear.length)       row.clear = clear;
    kpis.push(row);
  });

  closeMonthlyModal();

  if (kpis.length && dept) {
    try {
      await _kpiPut(dept, yr, mo, kpis);
    } catch (e) {
      // Local values already saved above (not blocking the user), but the
      // server never got them — other dashboards reading from the server
      // would silently diverge from what this user just entered.
      _kpiToast('Saved on this device only — server did not receive the update. Retry once you’re back online.', 'warn');
    }
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

/* ─── Daily Summary Report ────────────────────────────────────
   The covering table of the plant head's morning MIS mail, rebuilt at the
   foot of the Executive Summary from GET /api/mis/daily-summary/:date.

   Why it's here at all: reviewing the dashboard with the plant head, the
   Executive Summary showed only monthly KPI aggregates. The report he
   actually opens every morning — Mining, Stock and Production, each line
   with ON DATE, MTD and YTD — had no representation on the page he was
   being asked to use instead of it. Row order, grouping and wording follow
   his sheet rather than this app's own vocabulary, so the two read as the
   same report.

   The server decides what is and isn't sourceable and says why (see
   gatherDailySummary in backend/services/misReport.js). This file only
   renders that verdict: an unavailable row is drawn greyed with its reason
   next to it, never dropped. A line that vanishes from a report someone
   knows by heart reads as a bug in the dashboard; a line that is present
   and explains itself reads as the gap it actually is.

   The date is its own control, not the month/year filter bar at the top of
   the page: this section answers "what happened on one day", and every
   other control on the Executive Summary answers "how is the month going".
   It opens on the newest date that actually holds data (LatestPeriod), and
   says so when that isn't today. */

const DSR_COL_LABELS = {
  onDate:  'On Date',
  mtd:     'MTD',
  ytd:     'YTD',
  closing: 'Closing Stock',
  min:     'Min',
  max:     'Max',
};

/* Forms the Daily Summary actually reads, so its date isn't dragged
   forward by a form it never displays (same rule as latestDate's
   formTypes argument elsewhere). */
const DSR_FORMS = ['production', 'materials'];

let dsrDate = null;      // ISO date currently on screen
let dsrLoading = false;  // guards the ‹ › buttons against double-fires

function dsrNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  /* Tonnage reads as whole tonnes on the source sheet; anything under 100
     (free lime, small stock lines) keeps two decimals or it rounds to
     nothing. Same rule the workbook's own number formats use. */
  const dp = Math.abs(n) >= 100 ? 0 : 2;
  return n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

function dsrCell(row, col) {
  const raw = row[col];
  const txt = dsrNum(raw);
  if (txt === null) return '<td class="dsr-empty">—</td>';
  const cls = col === 'onDate' || col === 'closing' ? 'dsr-primary' : 'dsr-muted';
  let flag = '';
  /* The flag belongs on the stock figure itself, not on the threshold
     columns beside it — that's where the source sheet's Action column
     points too. */
  if ((col === 'closing') && row.status === 'below_min') flag = '<span class="dsr-flag below">below min</span>';
  if ((col === 'closing') && row.status === 'above_max') flag = '<span class="dsr-flag above">above max</span>';
  return '<td class="' + cls + '">' + escHtml(txt) + flag + '</td>';
}

function dsrSectionCard(section) {
  const cols = section.columns || [];
  /* "Description" is the source sheet's own first-column header — keeping it
     is most of what makes this table recognisable at a glance. */
  const head = '<tr><th>Description</th>' +
    cols.map(c => '<th>' + escHtml(DSR_COL_LABELS[c] || c) + '</th>').join('') + '</tr>';

  const body = section.rows.map(row => {
    if (row.available === false) {
      /* The section note is already on the card. Repeating it under every
         row turned an eleven-line Mining table into eleven copies of the
         same sentence — so a row only explains itself when it has its OWN
         reason (the surface-miner lines inside an otherwise-live section). */
      const own = row.reason && row.reason !== section.note ? row.reason : null;
      return '<tr class="dsr-row-na"><td class="dsr-label">' + escHtml(row.label) +
        (own ? '<span class="dsr-reason">' + escHtml(own) + '</span>' : '') + '</td>' +
        cols.map(() => '<td class="dsr-empty">—</td>').join('') + '</tr>';
    }
    const unit = row.unit ? '<span class="dsr-unit">' + escHtml(row.unit) + '</span>' : '';
    return '<tr><td class="dsr-label">' + escHtml(row.label) + unit + '</td>' +
      cols.map(c => dsrCell(row, c)).join('') + '</tr>';
  }).join('');

  const tag = section.available ? '' : '<span class="dsr-card-tag">No data</span>';
  const note = section.note
    ? '<div class="dsr-card-note">' + escHtml(section.note) + '</div>'
    : '';

  return '<div class="dsr-card' + (section.available ? '' : ' dsr-unavailable') +
      (section.key === 'production' ? ' dsr-wide' : '') + '">' +
    '<div class="dsr-card-head"><span class="dsr-card-title">' + escHtml(section.label) + '</span>' + tag + '</div>' +
    note +
    '<table class="dsr-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
    '</div>';
}

/* Which existing permission each section rides on.

   This report puts raw-material stock and quarry movements on the one page
   every role can open, so it must not become a side door around the access
   matrix: `store.rawmat` is denied to hr, it, sales, purchase, logistics,
   cpp, pm, ei and packing, and the Quarry KPI department to everyone outside
   md/admin/management/finance/mining. The Production block carries no new
   gate — Kiln Output, Despatch/Day and Specific Heat Consumption have always
   been on the Executive Summary for every role that can see it.

   Client-side, like the rest of this app's read visibility (routes/sales.js
   and routes/insights.js gate writes only, and GET /api/mis/daily/:date
   already returns every form's raw fields to any authenticated user). If
   that convention changes, this belongs in the route, not here. */
const DSR_SECTION_GATE = {
  production:     () => true,
  mining:         () => typeof canViewKPIDept !== 'function' || canViewKPIDept('mines'),
  stock:          () => typeof canView !== 'function' || canView('store', 'rawmat'),
  raw_mill_stock: () => typeof canView !== 'function' || canView('store', 'rawmat'),
  quarry_stock:   () => typeof canView !== 'function' || canView('store', 'rawmat'),
};

function dsrVisibleSections(payload) {
  /* The server returns the sections in the plant head's own sheet order
     (Mining → Stock → Production). Production is promoted to the top of the
     grid because it is the block he checks first and the one every other
     page's KPIs are built out of; the rest keep his order. */
  const allowed = payload.sections.filter(sec => {
    const gate = DSR_SECTION_GATE[sec.key];
    return gate ? gate() : false;   // an unknown section is not shown by default
  });
  return allowed.filter(s => s.key === 'production')
    .concat(allowed.filter(s => s.key !== 'production'));
}

function renderDailySummary(payload) {
  const grid = document.getElementById('dsr-grid');
  if (!grid) return;
  grid.innerHTML = dsrVisibleSections(payload).map(dsrSectionCard).join('');
}

function dsrMessage(text) {
  const grid = document.getElementById('dsr-grid');
  if (grid) grid.innerHTML = '<div class="dsr-placeholder">' + escHtml(text) + '</div>';
}

async function loadDailySummary(date) {
  const input = document.getElementById('dsr-date');
  const grid  = document.getElementById('dsr-grid');
  if (!grid) return;

  if (!window.NyatiAPI || !NyatiAPI.getDailySummary) {
    dsrMessage('The daily summary needs the server — it is not available offline.');
    return;
  }

  dsrDate = date;
  if (input) input.value = date;
  dsrLoading = true;
  dsrMessage('Loading the daily summary for ' + date + '…');

  try {
    const payload = await NyatiAPI.getDailySummary(date);
    renderDailySummary(payload);
  } catch (e) {
    dsrMessage('Could not load the daily summary for ' + date + ' (' +
      (e && e.status ? 'HTTP ' + e.status : 'server unreachable') + ').');
  } finally {
    dsrLoading = false;
  }
}

/* Opens on the newest date that holds Production/Materials data rather than
   on an empty "today", and says which day that is when it isn't today —
   the same fallback the other analytics pages use. */
async function initDailySummary() {
  const input = document.getElementById('dsr-date');
  const prev  = document.getElementById('dsr-prev');
  const next  = document.getElementById('dsr-next');
  if (!input) return;

  const LP = window.LatestPeriod || null;
  /* Local calendar date, never toISOString(): EAT is UTC+3, so between
     local midnight and 03:00 the UTC date is still yesterday. */
  const today = LP ? LP.todayIso() : (() => {
    const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  })();

  let start = LP ? await LP.defaultDate(DSR_FORMS) : null;
  if (!start) start = { date: today, fellBack: false, note: '' };
  if (LP && LP.showNote) {
    LP.showNote('dsr-note', start);
    const noteEl = document.getElementById('dsr-note');
    if (noteEl) noteEl.hidden = !start.fellBack;
  }

  /* Never offer a day that cannot have been reported yet. */
  input.max = today;

  const step = days => {
    if (dsrLoading || !dsrDate || !LP) return;
    const d = LP.addDaysIso(dsrDate, days);
    if (d > today) return;
    loadDailySummary(d);
  };
  if (prev) prev.addEventListener('click', () => step(-1));
  if (next) next.addEventListener('click', () => step(1));
  input.addEventListener('change', () => { if (input.value) loadDailySummary(input.value); });

  await loadDailySummary(start.date);
}

/* ─── INIT ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  attachInlineEditing();
  initDailySummary();
});
