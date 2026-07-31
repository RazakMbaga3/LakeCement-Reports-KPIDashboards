/* ══════════════════════════════════════════════════════════════
   Lake Cement Ltd – KPI Dashboard Logic
   ══════════════════════════════════════════════════════════════ */

const DEPT_META = {
  summary: {
    label: 'Executive Summary Dashboard',
    resp:  'Cross-departmental KPI overview — all departments',
  },
  ei: {
    label: 'E &amp; I — Electrical &amp; Instrumentation',
    resp:  'Responsibility: Mr. Ramesh Patel &amp; Team',
  },
  production: {
    label: 'Production Department',
    resp:  'Responsibility: Mr. Godhania &amp; Team',
  },
  mines: {
    label: 'Mines Department',
    resp:  'Responsibility: Mr. Mukesh Agrawal &amp; Team',
  },
  mechanical: {
    label: 'Mechanical Department',
    resp:  'Responsibility: Mr. Jai Prakash &amp; Team',
  },
  powerplant: {
    label: 'Power Plant Department',
    resp:  'Responsibility: Mr. Anbarasan &amp; Team',
  },
  packing: {
    label: 'Packing Plant Department',
    resp:  'Responsibility: Mr. Jatinder &amp; Team',
  },
  stores: {
    label: 'Stores Department',
    resp:  'Responsibility: Mr. Kishore &amp; Team',
  },
  minesworkshop: {
    label: 'Mines Workshop',
    resp:  'Responsibility: Mr. Yogesh &amp; Team',
  },
};

const MONTHS = [
  '', 'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

/* ─── Fiscal year (April → March) ────────────────────────────
   Lake Cement's business year runs April→March, not January→December.
   The KPI tables' 12 month columns are physically ordered April..March
   to match (see index.html) — "fiscal position" is the 0-based index
   into that column order: 0=April … 8=December, 9=January … 11=March.
   A fiscal year is named after its start year: "FY2026" = Apr 2026 →
   Mar 2027, so year-select's value is that start year, and Jan/Feb/Mar
   columns must be fetched from the *next* calendar year. Shared here
   (app.js loads before kpi-data.js) since both need this mapping. */
function calMonthToFiscalPos(mo) { return mo >= 4 ? mo - 4 : mo + 8; }
function fiscalPosToCalMonth(pos) { return pos < 9 ? pos + 4 : pos - 8; }
function fiscalPosToCalYear(pos, fyStartYear) { return pos < 9 ? +fyStartYear : +fyStartYear + 1; }

let currentDept = 'ei';

/* ─── switch department ─────────────────────────────────────── */
function switchDept(dept) {
  // Defense in depth: even though the nav buttons/dropdown are filtered
  // by role in applyKPIPermissions(), refuse to switch to a department
  // this role has no view rights to (e.g. a stale button, console call).
  if (typeof canViewKPIDept === 'function' && !canViewKPIDept(dept)) {
    dept = 'summary';
  }

  currentDept = dept;

  // hide all sections
  document.querySelectorAll('.dept-section').forEach(s => s.classList.add('hidden'));
  document.getElementById('dept-' + dept).classList.remove('hidden');

  // update nav buttons
  document.querySelectorAll('.nav-btn[data-dept]').forEach(b => {
    b.classList.toggle('active', b.dataset.dept === dept);
  });

  // sync dropdown
  document.getElementById('dept-select').value = dept;

  // update context bar
  const m = DEPT_META[dept];
  document.getElementById('ctx-dept-name').innerHTML = m.label;
  document.getElementById('ctx-resp').innerHTML = m.resp;

  updateSummary();
  if (dept === 'summary') {
    updateSummaryDashboard();
    applyPeriodCards(document.getElementById('view-select').value);
  }

  // Re-evaluate "Fill Monthly Data" visibility for the newly selected dept.
  if (typeof refreshFillButtonVisibility === 'function') refreshFillButtonVisibility();

  if (typeof refreshCompletenessBadge === 'function') {
    const mo = +document.getElementById('month-select').value;
    const yr =  document.getElementById('year-select').value;
    refreshCompletenessBadge(dept, mo, yr);
  }
}

/* ─── sync dept dropdown → nav ─────────────────────────────── */
function syncDeptSelect() {
  switchDept(document.getElementById('dept-select').value);
}

/* ─── apply month / year filters ───────────────────────────── */
function applyFilters() {
  const mo   = +document.getElementById('month-select').value;
  const yr   =  document.getElementById('year-select').value;
  const view =  document.getElementById('view-select').value;
  // "year-select" holds the FISCAL year's start year (e.g. 2026 = FY Apr
  // 2026 → Mar 2027). curFiscalPos is where the selected month falls in
  // that April..March sequence — see calMonthToFiscalPos() above.
  const curFiscalPos = calMonthToFiscalPos(mo);

  document.querySelectorAll('.kpi-table').forEach(tbl => {
    // Skip tables that don't use month columns (e.g. Mines Workshop equipment table)
    if (!tbl.querySelector('.thead-row th.col-month')) return;

    // Update table class so min-width CSS rule can apply
    tbl.classList.toggle('view-month', view === 'month' || view === 'daily');

    const headerCells = Array.from(tbl.querySelectorAll('.thead-row th'));

    // ── Rename the highlighted "Actual" column to the selected month name ──
    const actualHdr = tbl.querySelector('.thead-row .highlight-col');
    if (actualHdr) {
      actualHdr.innerHTML = view === 'daily' ? 'TODAY<br>ACTUAL' : MONTHS[mo] + '<br>ACTUAL';
    }

    // ── Show / hide month header cells (indices 6–17) ──
    // These columns are physically ordered April..March (fiscal order, see
    // index.html) so column index i maps directly to fiscal position i-6 —
    // no separate wraparound handling needed, "show fiscalPos <= current"
    // naturally spans Apr→Dec then Jan→Mar in one pass.
    headerCells.forEach((th, i) => {
      th.style.background = '';
      th.style.color = '';

      if (i < 6 || i > 17) return;
      const fiscalPos = i - 6; // 0=April … 11=March

      if (view === 'month' || view === 'daily') {
        th.style.display = 'none';
      } else if (view === 'ytd') {
        th.style.display = (fiscalPos <= curFiscalPos) ? '' : 'none';
      } else {
        // full year — show all, highlight selected
        th.style.display = '';
        if (fiscalPos === curFiscalPos) { th.style.background = '#E8750A'; th.style.color = '#fff'; }
      }
    });

    // ── Show / hide month data cells in body rows (skip section-rows) ──
    tbl.querySelectorAll('tbody tr').forEach(row => {
      if (row.classList.contains('section-row')) return;
      const cells = row.querySelectorAll('td');
      cells.forEach((td, i) => {
        if (i < 6 || i > 17) { td.style.opacity = '1'; return; }
        const fiscalPos = i - 6;
        if (view === 'month' || view === 'daily') {
          td.style.display = 'none';
          td.style.opacity  = '1';
        } else if (view === 'ytd') {
          td.style.display = (fiscalPos <= curFiscalPos) ? '' : 'none';
          td.style.opacity  = '1';
        } else {
          td.style.display = '';
          td.style.opacity  = (fiscalPos <= curFiscalPos) ? '1' : '0.2';
        }
      });
    });

    // ── Fix section-row colspans to match visible column count ──
    tbl.querySelectorAll('tbody .section-row').forEach(row => {
      const secTd = row.querySelector('td');
      if (!secTd) return;
      // Find the nearest following data-row to count its visible cells
      let ref = row.nextElementSibling;
      while (ref && !ref.classList.contains('data-row')) ref = ref.nextElementSibling;
      if (!ref) return;
      const visible = Array.from(ref.querySelectorAll('td'))
        .filter(td => td.style.display !== 'none').length;
      if (visible > 0) secTd.colSpan = visible;
    });
  });

  updateSummary();
  if (currentDept === 'summary') updateSummaryDashboard();
  applyPeriodCards(view);
  if (typeof loadKpiData === 'function') loadKpiData(mo, yr);
  if (typeof refreshCompletenessBadge === 'function') refreshCompletenessBadge(currentDept, mo, yr);
}

/* ─── compute achieved / not-achieved counts ────────────────── */
function updateSummary() {
  const section = document.getElementById('dept-' + currentDept);
  if (!section) return;
  const achieved = section.querySelectorAll('.achieved-tag').length;
  const notAchieved = section.querySelectorAll('.not-tag').length;
  const total = achieved + notAchieved;
  const rate  = total > 0 ? Math.round((achieved / total) * 100) : 0;

  document.getElementById('sum-achieved').textContent = achieved;
  document.getElementById('sum-not').textContent = notAchieved;
  document.getElementById('sum-rate').textContent = rate;
}

/* ─── Summary Dashboard updater ────────────────────────────── */
function updateSummaryDashboard() {
  // Per-dept achievement scorecard chips
  const DEPTS = ['ei','production','mines','mechanical','powerplant','packing','stores','minesworkshop'];
  DEPTS.forEach(d => {
    const section = document.getElementById('dept-' + d);
    if (!section) return;
    const achieved    = section.querySelectorAll('.achieved-tag').length;
    const notAchieved = section.querySelectorAll('.not-tag').length;
    const total = achieved + notAchieved;
    const rate  = total > 0 ? Math.round((achieved / total) * 100) : 0;
    const status = rate >= 75 ? 'on-track' : rate >= 55 ? 'watch' : 'concern';
    const lbl    = rate >= 75 ? 'On Track' : rate >= 55 ? 'Watch'  : 'Concern';

    const chip = document.querySelector(`.sc-chip[data-dept="${d}"]`);
    if (chip) { chip.className = 'sc-chip ' + status; }

    const pctEl = document.getElementById('sc-pct-' + d);
    if (pctEl) pctEl.textContent = rate + '%';

    const barEl = document.getElementById('sc-bar-' + d);
    if (barEl) barEl.style.width = rate + '%';

    const lblEl = document.getElementById('sc-lbl-' + d);
    if (lblEl) lblEl.textContent = lbl;
  });
}

/* ─── period analysis ───────────────────────────────────────── */
function getDailyValue(formId, fieldName) {
  const today = new Date().toISOString().slice(0, 10);
  const raw = localStorage.getItem('nyati-' + formId + '-' + today);
  if (!raw) return null;
  try { return JSON.parse(raw).data?.[fieldName] ?? null; }
  catch { return null; }
}

function applyPeriodCards(view) {
  const mo = +document.getElementById('month-select').value;
  const yr =  document.getElementById('year-select').value;

  // Update body class for CSS hooks
  ['daily','month','ytd','full'].forEach(p =>
    document.body.classList.toggle('period-' + p, p === view)
  );

  // Sync period-strip chips
  document.querySelectorAll('.per-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.period === view)
  );

  // Swap sk-card values for any remaining illustrative cards tagged with
  // data-daily/data-month/data-ytd/data-full (the formula-backed cards are
  // populated live by loadHeroCards() instead — see below).
  document.querySelectorAll('.sk-card[data-daily]').forEach(card => {
    const val  = card.dataset[view] ?? card.dataset.month;
    const valEl = card.querySelector('.sk-value');
    if (valEl && val) valEl.textContent = val;
  });

  // Formula-backed hero cards only have a real Month/YTD view — Today and
  // Full Year aren't computed by evalMonth, so re-fetch on any view change.
  if (typeof loadHeroCards === 'function') loadHeroCards(mo, yr, view);

  // Update period badge and context bar label. "yr" is the fiscal year's
  // start year (FY2026 = Apr 2026 → Mar 2027) — YTD/Full-Year text must
  // say so explicitly since neither span matches the calendar year alone.
  const badge = document.getElementById('smry-period-badge');
  const ctxPeriod = document.getElementById('ctx-period');
  const today = new Date();
  const fyStart = +yr;
  let periodText;
  if (view === 'daily') {
    periodText = 'Today — ' + today.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  } else if (view === 'month') {
    periodText = MONTHS[mo] + ' ' + fiscalPosToCalYear(calMonthToFiscalPos(mo), fyStart);
  } else if (view === 'ytd') {
    const endYr = fiscalPosToCalYear(calMonthToFiscalPos(mo), fyStart);
    periodText = 'YTD — Apr ' + fyStart + ' – ' + MONTHS[mo].slice(0, 3) + ' ' + endYr;
  } else {
    periodText = 'FY' + fyStart + ' (Apr ' + fyStart + ' – Mar ' + (fyStart + 1) + ')';
  }
  if (badge) badge.textContent = periodText;
  if (ctxPeriod) ctxPeriod.textContent = periodText;
}

function selectPeriod(view) {
  const sel = document.getElementById('view-select');
  if (sel) sel.value = view;
  applyFilters();
}

/* ─── live date ─────────────────────────────────────────────── */
function setDates() {
  const now = new Date();
  const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  const str  = now.toLocaleDateString('en-GB', opts);
  const el1  = document.getElementById('live-date');
  const el2  = document.getElementById('footer-date');
  if (el1) el1.textContent = str;
  if (el2) el2.textContent = str;
}

/* ─── default the Month/Year filters to today ───────────────────
   Previously these were hardcoded <option selected> values (Feb 2026)
   baked into the HTML, so the dashboard opened on a fixed stale period
   no matter when it was actually viewed. Default to the real current
   month/fiscal-year instead — if that fiscal year isn't in the dropdown
   yet (a new one rolling over), fall back to the latest year offered.
   year-select holds the FISCAL year's start year (April..March) — for
   Jan/Feb/Mar that's last calendar year, not this one. */
function setDefaultPeriod() {
  const now = new Date();
  const mo  = now.getMonth() + 1;
  const fyStart = mo >= 4 ? now.getFullYear() : now.getFullYear() - 1;

  const moSel = document.getElementById('month-select');
  const yrSel = document.getElementById('year-select');
  if (moSel) moSel.value = String(mo);

  if (yrSel) {
    const years = Array.from(yrSel.options).map(o => +o.value);
    yrSel.value = years.includes(fyStart) ? String(fyStart) : String(Math.max(...years));
  }
}

/* ─── INIT ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setDates();
  setDefaultPeriod();
  switchDept('summary');
  applyFilters();
});
