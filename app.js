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
    resp:  'Responsibility: Electrical &amp; Instrumentation HOD',
  },
  production: {
    label: 'Production Department',
    resp:  'Responsibility: Production &amp; QC Manager',
  },
  mines: {
    label: 'Mines Department',
    resp:  'Responsibility: Quarry Manager',
  },
  mechanical: {
    label: 'Mechanical Department',
    resp:  'Responsibility: Projects &amp; Maintenance HOD',
  },
  powerplant: {
    label: 'Power Plant Department',
    resp:  'Responsibility: Power Plant HOD',
  },
  packing: {
    label: 'Packing Plant Department',
    resp:  'Responsibility: Packing Plant HOD',
  },
  stores: {
    label: 'Stores Department',
    resp:  'Responsibility: Purchase &amp; Stores Manager',
  },
  minesworkshop: {
    label: 'Mines Workshop',
    resp:  'Responsibility: Mines Workshop Team',
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

/* ─── The 12 tracker columns ──────────────────────────────────
   Columns 6-17 of every KPI table. What each one MEANS depends on the view,
   and every consumer must agree — the header label, the cell the monthly
   values are written into, the cell an inline edit saves back to, and the
   range fetched from the server. This is that single answer; nothing should
   re-derive it.

     fiscal view  (Month / YTD / Full Year)
       the classic Apr→Mar tracker: column 6 is April of the selected fiscal
       year, column 17 is the following March.

     rolling view (Last 12 Months)
       the twelve months ENDING at the selected month, crossing the April
       boundary freely. The Apr→Mar layout cannot show a run of history that
       straddles a fiscal year — Jan–Jun 2026 sits in the last three columns
       of FY2025-26 and the first three of FY2026-27, so half of it is
       off-screen whichever year you pick. Rolling puts it in six adjacent
       columns.  */
const TRACKER_COL_MIN   = 6;
const TRACKER_COL_COUNT = 12;
const TRACKER_COL_MAX   = TRACKER_COL_MIN + TRACKER_COL_COUNT - 1;

function isRollingView(view) {
  return (view || document.getElementById('view-select')?.value) === 'rolling';
}

/* → 12 × {year, month}, left to right. */
function trackerColumns(mo, fyStart, view) {
  mo      = mo      != null ? +mo      : +document.getElementById('month-select').value;
  fyStart = fyStart != null ? +fyStart : +document.getElementById('year-select').value;

  if (isRollingView(view)) {
    const endYear = fiscalPosToCalYear(calMonthToFiscalPos(mo), fyStart);
    const out = [];
    for (let back = TRACKER_COL_COUNT - 1; back >= 0; back--) {
      const d = new Date(endYear, mo - 1 - back, 1);
      out.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }
    return out;
  }

  return Array.from({ length: TRACKER_COL_COUNT }, (_, pos) => ({
    year:  fiscalPosToCalYear(pos, fyStart),
    month: fiscalPosToCalMonth(pos),
  }));
}

/* Reverse: which column holds this calendar month, or -1 if it is off-window. */
function trackerColIndexFor(year, month, mo, fyStart, view) {
  const cols = trackerColumns(mo, fyStart, view);
  const i = cols.findIndex(c => c.year === +year && c.month === +month);
  return i < 0 ? -1 : TRACKER_COL_MIN + i;
}

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

  // update sidebar nav rows
  document.querySelectorAll('.sb-item[data-dept]').forEach(b => {
    b.classList.toggle('active', b.dataset.dept === dept);
  });

  // update context bar
  const m = DEPT_META[dept];
  document.getElementById('ctx-dept-name').innerHTML = m.label;
  document.getElementById('ctx-resp').innerHTML = m.resp;

  // Counting synchronously is right for a user-initiated switch: the tables
  // already hold this period's data. On the very first call (the
  // DOMContentLoaded bootstrap, which switches before applyFilters() so the
  // requested section is visible while the fetch runs) the counts are
  // meaningless — applyFilters() re-derives them as soon as the data lands.
  updateSummary();
  if (dept === 'summary') {
    updateSummaryDashboard();
    applyPeriodCards(document.getElementById('view-select').value);
  }

  // Re-evaluate "Fill Monthly Data" visibility for the newly selected dept.
  if (typeof refreshFillButtonVisibility === 'function') refreshFillButtonVisibility();
  refreshKpiLockState();

  if (typeof refreshCompletenessBadge === 'function') {
    const mo = +document.getElementById('month-select').value;
    const yr =  document.getElementById('year-select').value;
    refreshCompletenessBadge(dept, mo, yr);
  }
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
    tbl.classList.toggle('view-rolling', view === 'rolling');

    const headerCells = Array.from(tbl.querySelectorAll('.thead-row th'));

    // ── Rename the highlighted "Actual" column to the selected month name ──
    const actualHdr = tbl.querySelector('.thead-row .highlight-col');
    if (actualHdr) {
      actualHdr.innerHTML = view === 'daily' ? 'TODAY<br>ACTUAL' : MONTHS[mo] + '<br>ACTUAL';
    }

    /* ── Label the 12 tracker columns for whichever window is in force ──
       These were static April…March text, which is a lie in the rolling view
       and ambiguous in the fiscal one (a "Jan" column in FY2026-27 is Jan
       2027). Always name the month, and add the year wherever the window
       crosses into a new one so no column is ambiguous. */
    const cols = trackerColumns(mo, yr, view);
    headerCells.forEach((th, i) => {
      if (i < TRACKER_COL_MIN || i > TRACKER_COL_MAX) return;
      const c = cols[i - TRACKER_COL_MIN];
      const prev = cols[i - TRACKER_COL_MIN - 1];
      const showYear = !prev || prev.year !== c.year;
      th.innerHTML = MONTHS[c.month].slice(0, 3) + (showYear ? `<br><small>${c.year}</small>` : '');
    });

    // ── Show / hide month header cells (indices 6–17) ──
    // These columns are physically ordered April..March (fiscal order, see
    // index.html) so column index i maps directly to fiscal position i-6 —
    // no separate wraparound handling needed, "show fiscalPos <= current"
    // naturally spans Apr→Dec then Jan→Mar in one pass.
    headerCells.forEach((th, i) => {
      th.style.background = '';
      th.style.color = '';

      if (i < TRACKER_COL_MIN || i > TRACKER_COL_MAX) return;
      const fiscalPos = i - TRACKER_COL_MIN; // 0=April … 11=March (fiscal views)

      if (view === 'month' || view === 'daily') {
        th.style.display = 'none';
      } else if (view === 'ytd') {
        th.style.display = (fiscalPos <= curFiscalPos) ? '' : 'none';
      } else if (view === 'rolling') {
        // Every column is a real past month — show them all, mark the latest.
        th.style.display = '';
        if (fiscalPos === TRACKER_COL_COUNT - 1) { th.style.background = '#E8750A'; th.style.color = '#fff'; }
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
        const fiscalPos = i - TRACKER_COL_MIN;
        if (view === 'month' || view === 'daily') {
          td.style.display = 'none';
          td.style.opacity  = '1';
        } else if (view === 'ytd') {
          td.style.display = (fiscalPos <= curFiscalPos) ? '' : 'none';
          td.style.opacity  = '1';
        } else if (view === 'rolling') {
          td.style.display = '';
          td.style.opacity  = '1';   // every rolling column is a real past month
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

  applyPeriodCards(view);

  /* The achievement counts and the Executive Summary's per-department chips
     are derived by COUNTING the .achieved-tag / .not-tag cells the tables are
     currently showing — so they are only meaningful once loadKpiData() has
     finished writing this period's real values into those cells. Calling them
     before the fetch resolved was how the dashboard opened on a percentage
     computed from authoring-time HTML instead of from data. Await it. */
  const done = (typeof loadKpiData === 'function')
    ? Promise.resolve(loadKpiData(mo, yr))
    : Promise.resolve();
  done.then(() => {
    updateSummary();
    updateSummaryDashboard();
  });

  if (typeof refreshCompletenessBadge === 'function') refreshCompletenessBadge(currentDept, mo, yr);
  return done;
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

  /* No KPIs scored is not the same as every KPI missed. Left in the
     status palette, an empty month rendered as "0 Achieved / 0 Not
     Achieved / 0%" in green-red-blue, which reads as a plant-wide
     failure rather than as a month nobody has entered yet. */
  document.querySelector('.filter-summary')
    ?.classList.toggle('is-empty', total === 0);
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
/* Local calendar date as YYYY-MM-DD. Never toISOString(): east-of-UTC zones
   (EAT is UTC+3) push local midnight back into the previous UTC day, so every
   call between 00:00 and 03:00 local would silently ask for yesterday. Same
   helper insights.html/reliability.html already use. */
function isoLocalDate(d) {
  const p2 = n => (n < 10 ? '0' : '') + n;
  d = d || new Date();
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

function getDailyValue(formId, fieldName) {
  const today = isoLocalDate();
  const raw = localStorage.getItem('nyati-' + formId + '-' + today);
  if (!raw) return null;
  try { return JSON.parse(raw).data?.[fieldName] ?? null; }
  catch { return null; }
}

function applyPeriodCards(view) {
  const mo = +document.getElementById('month-select').value;
  const yr =  document.getElementById('year-select').value;

  // Update body class for CSS hooks
  ['daily','month','ytd','full','rolling'].forEach(p =>
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
  } else if (view === 'rolling') {
    const cols = trackerColumns(mo, fyStart, 'rolling');
    const a = cols[0], b = cols[cols.length - 1];
    periodText = 'Last 12 months — ' + MONTHS[a.month].slice(0, 3) + ' ' + a.year +
                 ' – ' + MONTHS[b.month].slice(0, 3) + ' ' + b.year;
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
/* Fiscal years to offer: the current one, the three before it (kpi_monthly
   history only goes back to FY2026 today, but the tracker is designed to
   accumulate) and the next one, so April's rollover needs no code change. */
function buildFiscalYearOptions() {
  const sel = document.getElementById('year-select');
  if (!sel || sel.options.length) return; // respect a server-rendered list
  const now = new Date();
  const cur = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  for (let y = cur - 3; y <= cur + 1; y++) {
    const o = document.createElement('option');
    o.value = String(y);
    o.textContent = `FY ${y}–${String(y + 1).slice(2)} (Apr'${String(y).slice(2)}–Mar'${String(y + 1).slice(2)})`;
    sel.appendChild(o);
  }
}

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

/* Open on a period that actually holds data.

   setDefaultPeriod() picks today's month, which is right in a plant filing
   reports daily and wrong the moment entry falls behind — and the Executive
   Summary had no way to tell those apart. Opened in September against a
   backfill ending in July it showed seven "No data submitted for September
   2026" cards and eight red 0% department chips: a dashboard reporting a
   catastrophic month, when in fact nobody had typed anything in yet. That is
   most of what "the executive summary doesn't look good" meant.

   Every other analytics page already solved this (forms/latest-period.js):
   fall back to the newest period that has data, and say so on screen. Never
   silently — a figure must always state which period it belongs to.

   Only ever on first load. Once someone picks a month, that is their choice,
   empty or not. */
async function applyLatestPeriodFallback() {
  const noteEl = document.getElementById('period-fallback-note');
  const moSel  = document.getElementById('month-select');
  const yrSel  = document.getElementById('year-select');
  if (!moSel || !yrSel || !window.LatestPeriod) return;

  /* Whatever is selected when the fetch starts. If someone picks a month
     while /api/mis/data-range is still in flight, that is a deliberate
     choice and the fallback must not overwrite it a moment later. */
  const openedOn = moSel.value + '|' + yrSel.value;

  const range = await LatestPeriod.dataRange();
  const last  = range && range.overall && range.overall.last;
  if (!last) return;                       // server unreachable — keep today
  if (moSel.value + '|' + yrSel.value !== openedOn) return;   // user got there first

  const lastIso   = String(last).slice(0, 10);
  const lastYear  = +lastIso.slice(0, 4);
  const lastMonth = +lastIso.slice(5, 7);
  const selMonth  = +moSel.value;
  const selYear   = fiscalPosToCalYear(calMonthToFiscalPos(selMonth), yrSel.value);
  if (lastYear * 100 + lastMonth >= selYear * 100 + selMonth) return;  // today has data

  const fyStart = lastMonth >= 4 ? lastYear : lastYear - 1;
  const years   = Array.from(yrSel.options).map(o => +o.value);
  if (!years.includes(fyStart)) return;    // outside the selectable range

  moSel.value = String(lastMonth);
  yrSel.value = String(fyStart);
  applyFilters();

  if (noteEl) {
    noteEl.hidden = false;
    noteEl.textContent =
      'Showing ' + MONTHS[lastMonth] + ' ' + lastYear +
      ' — the most recent period with data (nothing has been entered since ' +
      new Date(lastIso + 'T00:00:00').toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short', year: 'numeric' }) + ').';
  }
}

/* ─── INIT ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setDates();
  buildFiscalYearOptions();
  setDefaultPeriod();
  // Land on the department requested by a sidebar link from another page
  // (e.g. index.html?dept=ei), falling back to Executive Summary — same
  // rule sidebar.js uses to compute its own initial active row.
  const requested = new URLSearchParams(location.search).get('dept');
  const canView = typeof canViewKPIDept === 'function' ? canViewKPIDept : () => false;
  const landing = requested && canView(requested) ? requested : 'summary';

  // switchDept() before applyFilters() so the right section is visible while
  // the data loads; applyFilters() then fills every table and re-derives the
  // summary counts once the fetch settles.
  switchDept(landing);
  applyFilters();
  applyLatestPeriodFallback();
});

/* ══════════════════════════════════════════════════════════════════════
   MONTHLY KPI SUBMISSION LOCK
   An HOD fills a department-month, then submits it — at which point the
   figures become management's read-only record and kpi_monthly writes for
   that period are refused (409 KPI_PERIOD_LOCKED). Only admin/MD can
   reopen, and only with a reason.

   The server is the boundary; this is only so an HOD sees the state
   before clicking rather than after. A failed or slow lookup therefore
   leaves the Fill button exactly as refreshFillButtonVisibility() left it
   — never opened up, never hidden on a network blip.
══════════════════════════════════════════════════════════════════════ */

/* The dashboard's year-select holds the FISCAL year's start year, while
   kpi_submissions is keyed by calendar year — same resolution
   refreshCompletenessBadge() does before hitting a date-keyed API. */
function _kpiSelectedPeriod() {
  const mo = +document.getElementById('month-select').value;
  const fy =  document.getElementById('year-select').value;
  if (!mo || !fy) return null;
  const calYear = (typeof fiscalPosToCalYear === 'function' && typeof calMonthToFiscalPos === 'function')
    ? fiscalPosToCalYear(calMonthToFiscalPos(mo), fy)
    : +fy;
  return { dept: (typeof currentDept !== 'undefined') ? currentDept : 'summary', year: calYear, month: mo };
}

async function refreshKpiLockState() {
  const submitBtn = document.getElementById('submit-monthly-btn');
  const chip      = document.getElementById('kpi-lock-chip');
  /* By id: #submit-monthly-btn above carries the same .fill-monthly-btn
     class for its styling, so the class selector is no longer unique. */
  const fillBtn   = document.getElementById('fill-monthly-btn');
  if (!submitBtn || !chip) return;

  submitBtn.style.display = 'none';
  chip.style.display      = 'none';

  const p = _kpiSelectedPeriod();
  // Only a role that could edit this department has any use for the state.
  if (!p || typeof canFillKPIDept !== 'function' || !canFillKPIDept(p.dept)) return;
  if (['summary', 'minesworkshop'].includes(p.dept)) return;   // nothing fillable behind them

  let sub;
  try {
    sub = await NyatiAPI.getKpiSubmission(p.dept, p.year, p.month);
  } catch { return; }   // leave the UI as-is rather than guess

  // The user may have switched dept/month while the fetch was in flight.
  const now = _kpiSelectedPeriod();
  if (!now || now.dept !== p.dept || now.year !== p.year || now.month !== p.month) return;

  if (sub && sub.status === 'submitted') {
    if (fillBtn) fillBtn.style.display = 'none';
    const who  = sub.submitted_by || 'the HOD';
    const when = sub.submitted_at ? String(sub.submitted_at).slice(0, 10) : '';
    chip.textContent = `Submitted${when ? ' ' + when : ''} by ${who} — locked`;
    chip.title = 'These figures are final. An administrator or the MD must reopen the month before it can be edited.';
    chip.style.display = '';
  } else {
    submitBtn.style.display = '';
  }
}

async function submitMonthlyKPIs() {
  const p = _kpiSelectedPeriod();
  if (!p) return;
  const label = `${p.dept} ${p.year}-${String(p.month).padStart(2, '0')}`;
  if (!confirm(
    `Submit ${label} as final?\n\n` +
    'These figures become the record management reads, and you will not be able to ' +
    'edit them afterwards. Only an administrator or the MD can reopen the month.'
  )) return;

  const btn = document.getElementById('submit-monthly-btn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
  try {
    const r = await NyatiAPI.submitKpiMonth(p.dept, p.year, p.month);
    alert(`${label} submitted — ${r.count} KPI row(s) locked.`);
  } catch (e) {
    alert(e.message);   // server's own wording: empty month, already locked, wrong dept
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    refreshKpiLockState();
  }
}
