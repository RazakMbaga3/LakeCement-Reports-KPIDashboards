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
    headerCells.forEach((th, i) => {
      th.style.background = '';
      th.style.color = '';

      if (i < 6 || i > 17) return;
      const mIdx = i - 5; // i=6 → mIdx=1 (Jan) … i=17 → mIdx=12 (Dec)

      if (view === 'month' || view === 'daily') {
        th.style.display = 'none';
      } else if (view === 'ytd') {
        th.style.display = (mIdx <= mo) ? '' : 'none';
      } else {
        // full year — show all, highlight selected
        th.style.display = '';
        if (mIdx === mo) { th.style.background = '#E8750A'; th.style.color = '#fff'; }
      }
    });

    // ── Show / hide month data cells in body rows (skip section-rows) ──
    tbl.querySelectorAll('tbody tr').forEach(row => {
      if (row.classList.contains('section-row')) return;
      const cells = row.querySelectorAll('td');
      cells.forEach((td, i) => {
        if (i < 6 || i > 17) { td.style.opacity = '1'; return; }
        const mIdx = i - 5;
        if (view === 'month' || view === 'daily') {
          td.style.display = 'none';
          td.style.opacity  = '1';
        } else if (view === 'ytd') {
          td.style.display = (mIdx <= mo) ? '' : 'none';
          td.style.opacity  = '1';
        } else {
          td.style.display = '';
          td.style.opacity  = (mIdx <= mo) ? '1' : '0.2';
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

  // Update period badge and context bar label
  const badge = document.getElementById('smry-period-badge');
  const ctxPeriod = document.getElementById('ctx-period');
  const today = new Date();
  let periodText;
  if (view === 'daily') {
    periodText = 'Today — ' + today.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  } else if (view === 'month') {
    periodText = MONTHS[mo] + ' ' + yr;
  } else if (view === 'ytd') {
    periodText = 'YTD — Jan–' + MONTHS[mo].slice(0, 3) + ' ' + yr;
  } else {
    periodText = 'Full Year ' + yr;
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
   month/year instead — if that year isn't in the dropdown yet (a new
   year rolling over), fall back to the latest year offered. */
function setDefaultPeriod() {
  const now = new Date();
  const mo  = now.getMonth() + 1;
  const yr  = now.getFullYear();

  const moSel = document.getElementById('month-select');
  const yrSel = document.getElementById('year-select');
  if (moSel) moSel.value = String(mo);

  if (yrSel) {
    const years = Array.from(yrSel.options).map(o => +o.value);
    yrSel.value = years.includes(yr) ? String(yr) : String(Math.max(...years));
  }
}

/* ─── INIT ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setDates();
  setDefaultPeriod();
  switchDept('summary');
  applyFilters();
});
