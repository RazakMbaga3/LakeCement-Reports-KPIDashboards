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
  mining: {
    label: 'Mining &amp; Mines Workshop',
    resp:  'Responsibility: Mines Workshop Team',
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
  if (dept === 'summary') updateSummaryDashboard();
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

  document.getElementById('ctx-period').textContent = MONTHS[mo] + ' ' + yr;

  document.querySelectorAll('.kpi-table').forEach(tbl => {
    // Skip tables that don't use month columns (e.g. Mines Workshop equipment table)
    if (!tbl.querySelector('.thead-row th.col-month')) return;

    // Update table class so min-width CSS rule can apply
    tbl.classList.toggle('view-month', view === 'month');

    const headerCells = Array.from(tbl.querySelectorAll('.thead-row th'));

    // ── Rename the highlighted "Actual" column to the selected month name ──
    const actualHdr = tbl.querySelector('.thead-row .highlight-col');
    if (actualHdr) actualHdr.innerHTML = MONTHS[mo] + '<br>ACTUAL';

    // ── Show / hide month header cells (indices 6–17) ──
    headerCells.forEach((th, i) => {
      th.style.background = '';
      th.style.color = '';

      if (i < 6 || i > 17) return;
      const mIdx = i - 5; // i=6 → mIdx=1 (Jan) … i=17 → mIdx=12 (Dec)

      if (view === 'month') {
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
        if (view === 'month') {
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
  // Sync period badge
  const mo = +document.getElementById('month-select').value;
  const yr =  document.getElementById('year-select').value;
  const badge = document.getElementById('smry-period-badge');
  if (badge) badge.textContent = MONTHS[mo] + ' ' + yr;

  // Sync the smry-period in context bar
  const ctxPeriod = document.getElementById('ctx-period');
  if (ctxPeriod) ctxPeriod.textContent = MONTHS[mo] + ' ' + yr;

  // Per-dept achievement scorecard chips
  const DEPTS = ['ei','production','mining','mines','mechanical','powerplant','packing','stores','minesworkshop'];
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

  // Days since last LTI (computed from Jan 1 of current year)
  const ltiEl = document.getElementById('smry-days-lti');
  if (ltiEl) {
    const startOfYear = new Date(new Date().getFullYear(), 0, 1);
    const daysSince = Math.floor((new Date() - startOfYear) / 86400000);
    ltiEl.textContent = daysSince;
  }
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

/* ─── INIT ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setDates();
  switchDept('summary');
  applyFilters();
});
