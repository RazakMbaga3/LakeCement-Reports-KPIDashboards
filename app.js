/* ══════════════════════════════════════════════════════════════
   Lake Cement Ltd – KPI Dashboard Logic
   ══════════════════════════════════════════════════════════════ */

const DEPT_META = {
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
}

/* ─── sync dept dropdown → nav ─────────────────────────────── */
function syncDeptSelect() {
  switchDept(document.getElementById('dept-select').value);
}

/* ─── apply month / year filters ───────────────────────────── */
function applyFilters() {
  const mo   = +document.getElementById('month-select').value;
  const yr   = document.getElementById('year-select').value;
  const view = document.getElementById('view-select').value;

  // Update context period label
  document.getElementById('ctx-period').textContent =
    MONTHS[mo] + ' ' + yr;

  // Highlight the selected month column in all tables
  document.querySelectorAll('.kpi-table').forEach(tbl => {
    const headerCells = tbl.querySelectorAll('.thead-row th');
    // month cols start at index 6 (Jan=6 … Dec=17)
    headerCells.forEach((th, i) => {
      th.style.background = '';
      th.style.color = '';
    });

    // month index offset: Jan = col index 6
    const colIdx = 6 + (mo - 1);

    // highlight selected month header
    if (headerCells[colIdx]) {
      headerCells[colIdx].style.background = '#E8750A';
      headerCells[colIdx].style.color = '#fff';
    }

    // dim future month columns in YTD view
    tbl.querySelectorAll('.data-row').forEach(row => {
      const cells = row.querySelectorAll('td');
      cells.forEach((td, i) => {
        if (i >= 6 && i <= 17) {
          const mIdx = i - 6 + 1; // 1=Jan
          if (view === 'month') {
            td.style.opacity = (mIdx === mo) ? '1' : '0.35';
          } else if (view === 'ytd') {
            td.style.opacity = (mIdx <= mo) ? '1' : '0.2';
          } else {
            td.style.opacity = '1';
          }
        }
      });
    });
  });

  updateSummary();
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
  switchDept('ei');
  applyFilters();
});
