/* ══════════════════════════════════════════════════════════════════
   Lake Cement – Trend Analytics Engine
   ─────────────────────────────────────────────────────────────────
   Reads all nyati-{formId}-{YYYY-MM-DD} keys from localStorage,
   builds time-series for 6 KPIs, renders Chart.js trend lines,
   and surfaces spec violations + statistical anomalies.
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Helpers ─────────────────────────────────────────────────── */
  function n(v) { var x = parseFloat(v); return isNaN(x) ? 0 : x; }
  function nvl(v) { var x = parseFloat(v); return isNaN(x) ? null : x; }

  function fmtNum(v, dec, unit) {
    if (v === null || v === undefined) return '—';
    if (unit === 'kWh' && v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return v.toFixed(dec != null ? dec : 1) + (unit ? ' ' + unit : '');
  }

  function fmtDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  /* ── Date range builder ──────────────────────────────────────────
     `endIso` lets the trailing window end somewhere other than today. With
     the current backfill stopping mid-July, a 30-day window anchored on
     today produced 15 empty charts that read as a broken page rather than as
     "nothing has been entered for six weeks" — see forms/latest-period.js.
     Dates are built from LOCAL parts, never toISOString(): EAT is UTC+3, so
     between local midnight and 03:00 the UTC date is still yesterday. */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  function buildRange(days, endIso) {
    var dates = [];
    var end   = endIso ? new Date(endIso + 'T00:00:00') : new Date();
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(end);
      d.setDate(d.getDate() - i);
      dates.push(isoOf(d));
    }
    return dates;
  }

  /* Every day in a given calendar month (yearMonth = "YYYY-MM"), regardless
     of today's date — lets a past month be viewed on its own instead of
     only trailing windows anchored to today. */
  function buildRangeForMonth(yearMonth) {
    var parts = yearMonth.split('-');
    var year = parseInt(parts[0], 10), month = parseInt(parts[1], 10); // 1-indexed month
    var daysInMonth = new Date(year, month, 0).getDate();
    var dates = [];
    for (var day = 1; day <= daysInMonth; day++) {
      dates.push(year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'));
    }
    return dates;
  }

  /* ══════════════════════════════════════════════════════════════
     METRIC DEFINITIONS — driven by the shared formula registry.

     NO FORMULA MATH HERE: forms/formula-registry.js (loaded before
     this file) is the single source for label/unit/dp/target and the
     daily() functions. This block only maps registry keys to chart
     DOM ids and colors. Values prefer the server's formula engine
     (/api/formula/daily); the registry's own daily() runs locally
     as the offline/demo-data fallback — same functions, same math.
  ══════════════════════════════════════════════════════════════ */
  var REG = window.NyatiFormulas || { FACTS: {}, FORMULAS: {} };

  var CHART_STYLE = [
    { id: 'free-cao',  key: 'clinker-free-lime',                    color: '#e53935', fillColor: 'rgba(229,57,53,0.08)' },
    { id: 'blaine',    key: 'blaine-425r',                          color: '#239557', fillColor: 'rgba(35,149,87,0.08)' },
    { id: 'strength',  key: 'strength-28d',                         color: '#4F74B2', fillColor: 'rgba(79,116,178,0.08)' },
    { id: 'pile-cao',  key: 'pile-cao-avg',                         color: '#7c3aed', fillColor: 'rgba(124,58,237,0.08)' },
    { id: 'dispatch',  key: 'despatch-day',                         color: '#F49545', fillColor: 'rgba(244,149,69,0.08)' },
    { id: 'power',     key: 'total-power-kwh',                      color: '#0d9488', fillColor: 'rgba(13,148,136,0.08)' },
    { id: 'clinker',   key: 'kiln-output',                          color: '#F49545', fillColor: 'rgba(244,149,69,0.08)' },
    { id: 'sp-heat',   key: 'specific-thermal-energy-consumption',  color: '#7c3aed', fillColor: 'rgba(124,58,237,0.08)' },
    { id: 'spc-total',    key: 'specific-power-consumption-total',              color: '#0d9488', fillColor: 'rgba(13,148,136,0.08)' },
    { id: 'spc-clinker',  key: 'specific-power-consumption-up-to-clinker',      color: '#0d9488', fillColor: 'rgba(13,148,136,0.08)' },
    { id: 'spc-grind',    key: 'specific-power-consumption-cement-grinding',    color: '#0d9488', fillColor: 'rgba(13,148,136,0.08)' },
    { id: 'pwr-loss',     key: 'power-distribution-loss-pct',                   color: '#e53935', fillColor: 'rgba(229,57,53,0.08)' },
    { id: 'clinker-src',  key: 'purchased-clinker-share',                       color: '#7c3aed', fillColor: 'rgba(124,58,237,0.08)' },
    /* Stoppage minute trend cards (total + kiln) used to live here — now
       superseded by reliability.html (availability/MTBF/paired Pareto/
       RCFA, from the same stop_<equip>_<cause> data). See the link-through
       card in the "Stoppages & Materials" section of analytics.html. */
    { id: 'mat-clinker',  key: 'clinker-consumption-day',                       color: '#173158', fillColor: 'rgba(23,49,88,0.08)' },
    { id: 'mat-coal',     key: 'coal-kiln-consumption-day',                     color: '#173158', fillColor: 'rgba(23,49,88,0.08)' },
  ];

  /* Resolve one day's fact values for a formula from the harvested store */
  function factsFor(formula, store, date) {
    var facts = {}, any = false;
    formula.inputs.forEach(function (k) {
      var fact = REG.FACTS[k];
      var day  = fact && store[fact.form] ? store[fact.form][date] : null;
      var v    = day ? nvl(day[fact.field]) : null;
      facts[k] = v;
      if (v !== null) any = true;
    });
    return any ? facts : null;
  }

  var METRICS = CHART_STYLE.filter(function (cs) { return REG.FORMULAS[cs.key]; })
    .map(function (cs) {
      var f = REG.FORMULAS[cs.key];
      var forms = [];
      f.inputs.forEach(function (k) {
        var form = REG.FACTS[k] && REG.FACTS[k].form;
        if (form && forms.indexOf(form) === -1) forms.push(form);
      });
      return {
        id: cs.id, key: cs.key, forms: forms,
        label: f.label + (f.unit ? ' (' + f.unit + ')' : ''),
        unit: f.unit, dec: f.dp,
        target: f.target === undefined ? null : f.target,
        targetDir: f.signage === '<' ? '<=' : (f.signage === '>' ? '>=' : f.signage),
        targetLabel: f.targetLabel,
        color: cs.color, fillColor: cs.fillColor,
        metric: function (store, date) {
          var facts = factsFor(f, store, date);
          if (!facts) return null;
          var v;
          try { v = f.daily(facts); } catch (e) { v = null; }
          return (v === null || v === undefined || isNaN(v)) ? null : v;
        },
      };
    });

  /* ── Harvest form data for the trend window ───────────────────────
     Per form: read local snapshots first (covers offline data AND
     seedDemoData(), which is intentionally local-only — see below),
     then overlay server records for the same date range, server taking
     precedence when both exist for a date. This is a merge, not a
     try-server-else-local fallback, specifically so demo data (which the
     server has never heard of and always returns "no rows" for) still
     renders — a thrown/failed server call falls back the same way. ──── */
  async function harvest(dates) {
    var cutoff  = dates[0];
    var todayIso = dates[dates.length - 1];
    var forms = [];
    METRICS.forEach(function(m) {
      m.forms.forEach(function(f) { if (forms.indexOf(f) === -1) forms.push(f); });
    });

    var store = {};

    await Promise.all(forms.map(async function(formId) {
      store[formId] = {};

      var re = new RegExp('^nyati-' + formId + '-(\\d{4}-\\d{2}-\\d{2})$');
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key) continue;
        var m = key.match(re);
        if (!m) continue;
        var date = m[1];
        if (date < cutoff || date > todayIso) continue;
        try {
          var payload = JSON.parse(localStorage.getItem(key));
          store[formId][date] = payload.data || {};
        } catch(_) {}
      }

      if (window.NyatiAPI) {
        try {
          var records = await window.NyatiAPI.getFormRange(formId, cutoff, todayIso);
          records.forEach(function(r) {
            var d = r.record_date ? String(r.record_date).slice(0, 10) : null;
            if (d) store[formId][d] = r.data || {};
          });
        } catch (e) { /* server unreachable — local-only data above still stands */ }
      }
    }));

    return store;
  }

  /* ── Anomaly detection (statistical) ─────────────────────────── */
  function stdDev(vals) {
    if (vals.length < 2) return 0;
    var mean = vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
    var variance = vals.map(function(v) { return (v - mean) * (v - mean); })
                       .reduce(function(a, b) { return a + b; }, 0) / vals.length;
    return { mean: mean, std: Math.sqrt(variance) };
  }

  /* Trailing N-day average, gaps-aware (nulls excluded from the window,
     not treated as zero); null where the window has no data at all. */
  function rollingAverage(values, windowSize) {
    return values.map(function (_, i) {
      var start = Math.max(0, i - windowSize + 1);
      var slice = values.slice(start, i + 1).filter(function (v) { return v !== null; });
      return slice.length ? slice.reduce(function (a, b) { return a + b; }, 0) / slice.length : null;
    });
  }

  function anomalyMask(values) {
    var valid = values.filter(function(v) { return v !== null; });
    if (valid.length < 4) return values.map(function() { return false; });
    var s = stdDev(valid);
    return values.map(function(v) {
      return v !== null && s.std > 0 && Math.abs(v - s.mean) > 1.8 * s.std;
    });
  }

  /* ── Trend direction ──────────────────────────────────────────── */
  function trendArrow(values, targetDir) {
    var valid = values.filter(function(v) { return v !== null; });
    if (valid.length < 2) return { symbol: '—', color: '' };
    var half = Math.max(1, Math.floor(valid.length / 2));
    var first = valid.slice(0, half).reduce(function(a,b){return a+b;},0) / half;
    var last  = valid.slice(-half).reduce(function(a,b){return a+b;},0) / half;
    var pct   = (last - first) / (Math.abs(first) || 1) * 100;
    var goingUp = pct > 3, goingDown = pct < -3;
    if (!goingUp && !goingDown) return { symbol: '→', color: 'var(--text-muted)' };
    /* Color: green if direction matches target, red if against target */
    var good = targetDir === '>=' ? goingUp : (targetDir === '<=' ? goingDown : null);
    /* These paint TEXT (an arrow and its percentage), so they take the
       AA-passing inks, not the raw brand/palette hues. */
    var color = good === null ? 'var(--text-muted)'
              : (good ? 'var(--green-ink)' : 'var(--red-ink)');
    return { symbol: goingUp ? '↑' : '↓', color: color };
  }

  /* ── Spec violation check ─────────────────────────────────────── */
  function isViolation(value, target, dir) {
    if (target === null || value === null) return false;
    if (dir === '<=') return value > target;
    if (dir === '>=') return value < target;
    return false;
  }

  /* ── Update stat chips ────────────────────────────────────────── */
  function updateStats(metric, values) {
    var valid = values.filter(function(v) { return v !== null; });
    var latest = null;
    for (var i = values.length - 1; i >= 0; i--) {
      if (values[i] !== null) { latest = values[i]; break; }
    }
    var avg = valid.length ? valid.reduce(function(a,b){return a+b;},0) / valid.length : null;
    var trend = trendArrow(values, metric.targetDir);

    var dec = metric.dec;
    var unit = metric.unit;

    var elCur   = document.getElementById('stat-' + metric.id + '-cur');
    var elAvg   = document.getElementById('stat-' + metric.id + '-avg');
    var elTrend = document.getElementById('stat-' + metric.id + '-trend');
    if (!elCur) return;

    elCur.textContent = latest !== null ? latest.toFixed(dec) + (unit ? ' ' + unit : '') : '—';
    elAvg.textContent = avg    !== null ? avg.toFixed(dec)    + (unit ? ' ' + unit : '') : '—';
    elTrend.textContent = trend.symbol;
    if (trend.color) elTrend.style.color = trend.color;

    /* RAG colour on latest */
    elCur.className = 'an-stat-val';
    if (latest !== null && metric.target !== null) {
      var bad = isViolation(latest, metric.target, metric.targetDir);
      elCur.classList.add(bad ? 'fail' : 'ok');
    }
  }

  /* ── Chart.js instance map ────────────────────────────────────── */
  var _charts = {};

  /* ── Render one chart ─────────────────────────────────────────── */
  function renderChart(metric, dates, values) {
    var hasData = values.some(function(v) { return v !== null; });
    var wrap   = document.querySelector('#card-' + metric.id + ' .an-chart-wrap');
    var empty  = document.getElementById('empty-' + metric.id);

    if (!hasData) {
      if (wrap)  wrap.style.display  = 'none';
      if (empty) empty.style.display = 'flex';
      if (_charts[metric.id]) { _charts[metric.id].destroy(); delete _charts[metric.id]; }
      return;
    }
    if (wrap)  wrap.style.display  = 'block';
    if (empty) empty.style.display = 'none';

    var anom    = anomalyMask(values);
    var labels  = dates.map(fmtDate);

    /* Anomaly scatter points */
    var anomData = values.map(function(v, i) { return anom[i] ? v : null; });

    /* 7-day rolling average — smooths day-to-day noise so drift shows up
       before it's a crisis, without hiding the raw daily points. */
    var rollingData = rollingAverage(values, 7);

    /* Target line (constant) */
    var targetData = metric.target !== null
      ? dates.map(function() { return metric.target; })
      : null;

    var datasets = [
      {
        label: metric.label,
        data: values,
        borderColor: metric.color,
        backgroundColor: metric.fillColor,
        borderWidth: 2,
        pointRadius: values.map(function(v, i) { return anom[i] ? 0 : (v !== null ? 3 : 0); }),
        pointBackgroundColor: metric.color,
        pointBorderColor: 'white',
        pointBorderWidth: 1.5,
        fill: true,
        tension: 0.35,
        spanGaps: true,
      },
      {
        label: 'Anomaly',
        data: anomData,
        type: 'scatter',
        pointRadius: 6,
        pointHoverRadius: 7,
        pointBackgroundColor: '#e53935',
        pointBorderColor: 'white',
        pointBorderWidth: 2,
        showLine: false,
      },
      {
        label: '7-day avg',
        data: rollingData,
        borderColor: metric.color,
        borderWidth: 2,
        borderDash: [2, 2],
        pointRadius: 0,
        fill: false,
        tension: 0.25,
        spanGaps: true,
      },
    ];

    if (targetData) {
      datasets.push({
        label: metric.targetLabel || 'Target',
        data: targetData,
        borderColor: 'rgba(100,116,139,0.45)',
        borderWidth: 1.5,
        borderDash: [5, 4],
        pointRadius: 0,
        fill: false,
        tension: 0,
      });
    }

    var ctx = document.getElementById('chart-' + metric.id);
    if (!ctx) return;

    if (_charts[metric.id]) _charts[metric.id].destroy();

    _charts[metric.id] = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(23,49,88,0.92)',
            titleColor: 'rgba(255,255,255,0.6)',
            bodyColor: 'white',
            titleFont: { size: 10, weight: '600' },
            bodyFont: { size: 12, weight: '700', family: 'Inter, sans-serif' },
            padding: 10,
            cornerRadius: 7,
            callbacks: {
              label: function(ctx) {
                if (ctx.dataset.label === 'Anomaly' && ctx.parsed.y === null) return null;
                if (ctx.dataset.label === 'Anomaly' && ctx.parsed.y !== null) {
                  return '⚠ Anomaly: ' + ctx.parsed.y.toFixed(metric.dec) + (metric.unit ? ' ' + metric.unit : '');
                }
                if (ctx.parsed.y === null) return null;
                var val = ctx.parsed.y.toFixed(metric.dec) + (metric.unit ? ' ' + metric.unit : '');
                var prefix = metric.target !== null
                  ? (isViolation(ctx.parsed.y, metric.target, metric.targetDir) ? '✕ ' : '✓ ')
                  : '';
                return prefix + val;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
            ticks: {
              font: { size: 9, family: 'Inter, sans-serif', weight: '600' },
              color: '#9CA3AF',
              maxTicksLimit: 10,
              maxRotation: 0,
            },
            border: { display: false },
          },
          y: {
            grid: { color: 'rgba(0,0,0,0.05)', drawBorder: false },
            ticks: {
              font: { size: 9, family: 'Inter, sans-serif', weight: '600' },
              color: '#9CA3AF',
              callback: function(v) {
                if (metric.unit === 'kWh' && v >= 1000) return (v/1000).toFixed(0)+'k';
                return v;
              },
            },
            border: { display: false },
          },
        },
        animation: { duration: 350, easing: 'easeOutQuart' },
      },
    });

    /* fix canvas height after create */
    ctx.style.height = '200px';

    updateStats(metric, values);
  }

  /* ── Collect anomalies for the table ──────────────────────────── */
  function buildAnomalyTable(allAnomalies) {
    var body  = document.getElementById('an-anomaly-body');
    var count = document.getElementById('an-anomaly-count');
    var badge = document.getElementById('badge-anomaly');
    if (!body) return;

    allAnomalies.sort(function(a, b) { return b.date.localeCompare(a.date); });

    if (!allAnomalies.length) {
      body.innerHTML = '<div class="an-no-anomaly"><span>✅</span>No anomalies detected in this period</div>';
      if (count) count.textContent = '0 flagged';
      if (badge) badge.textContent = '0 anomalies';
      return;
    }

    if (count) count.textContent = allAnomalies.length + ' flagged';
    if (badge) badge.textContent = allAnomalies.length + ' anomalies';

    var rows = allAnomalies.map(function(a) {
      var typeHtml = a.type === 'spec'
        ? '<span class="an-atype-spec">Spec violation</span>'
        : '<span class="an-atype-stat">Statistical outlier</span>';
      return '<tr>' +
        '<td>' + a.dateLabel + '</td>' +
        '<td style="color:var(--navy);font-weight:700">' + a.metric + '</td>' +
        /* The value wears ink, not the series colour: a hue chosen to
           separate lines on a chart is not chosen to be legible as
           13px text, and two of them measured 2.27:1 and 3.74:1 here.
           Identity moves to a swatch beside the number. */
        '<td style="font-weight:700;color:var(--text-main)">' +
          '<span class="an-swatch" style="background:' + a.color + '"></span>' +
          a.value + '</td>' +
        '<td>' + typeHtml + '</td>' +
        '<td style="color:var(--text-muted)">' + (a.note || '') + '</td>' +
      '</tr>';
    }).join('');

    body.innerHTML =
      '<table class="an-atable">' +
        '<thead><tr>' +
          '<th>Date</th><th>KPI</th><th>Value</th><th>Type</th><th>Note</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  /* ── Coverage chips ───────────────────────────────────────────── */
  function updateCoverage(store, dates) {
    var days = dates.length;
    var chips = document.getElementById('an-cov-chips');
    if (!chips) return;

    var defs = [
      { key: 'quality',      label: 'Quality' },
      { key: 'production',   label: 'Production' },
      { key: 'dispatch',     label: 'Dispatch' },
      { key: 'power-cons',   label: 'Power' },
      { key: 'pile-quality', label: 'Pile' },
      { key: 'stoppage',     label: 'Stoppage' },
      { key: 'materials',    label: 'Materials' },
    ];

    chips.innerHTML = defs.map(function(d) {
      var count = store[d.key] ? Object.keys(store[d.key]).length : 0;
      var pct   = Math.round(count / days * 100);
      var cls   = pct >= 70 ? 'an-cov-good' : (pct > 0 ? 'an-cov-fair' : 'an-cov-none');
      var dotC  = pct >= 70 ? 'var(--st-good)' : (pct > 0 ? 'var(--st-warn)' : 'var(--st-bad)');
      return '<span class="an-cov-chip ' + cls + '">' +
        '<span class="an-cov-dot" style="background:' + dotC + '"></span>' +
        d.label + ': ' + count + 'd' +
        '</span>';
    }).join('');

    /* section badges */
    var qDays  = store['quality']      ? Object.keys(store['quality']).length      : 0;
    var pqDays = store['pile-quality'] ? Object.keys(store['pile-quality']).length : 0;
    var dDays  = store['dispatch']     ? Object.keys(store['dispatch']).length      : 0;
    var pwDays = store['power-cons']   ? Object.keys(store['power-cons']).length   : 0;
    var prDays = store['production']   ? Object.keys(store['production']).length     : 0;
    var stDays = store['stoppage']     ? Object.keys(store['stoppage']).length       : 0;
    var mtDays = store['materials']    ? Object.keys(store['materials']).length      : 0;
    var el = document.getElementById('badge-quality');
    if (el) el.textContent = (qDays + pqDays) + ' form-days';
    el = document.getElementById('badge-production');
    if (el) el.textContent = prDays + ' form-days';
    el = document.getElementById('badge-operations');
    if (el) el.textContent = (dDays + pwDays) + ' form-days';
    el = document.getElementById('badge-energy');
    if (el) el.textContent = (prDays + pwDays) + ' form-days';
    el = document.getElementById('badge-stoppage-materials');
    if (el) el.textContent = (stDays + mtDays) + ' form-days';
  }

  /* ═══════════════════════════════════════════════════════════════
     MAIN RENDER
  ═══════════════════════════════════════════════════════════════ */
  /* Either { type:'days', days:N } (trailing window, re-evaluated against
     "today" on every render) or { type:'month', yearMonth:"YYYY-MM" }
     (pinned historical month). render() always re-derives dates from this
     so a later re-render (storage event, demo data) reflects the same
     period the user picked, not whatever was current on first load. */
  var _currentRange = { type: 'days', days: 30 };
  /* Set once at bootstrap from GET /api/mis/data-range when the newest entry
     predates today; null means "anchor on today" as before. */
  var _rangeEnd = null;

  function currentDates() {
    return _currentRange.type === 'month'
      ? buildRangeForMonth(_currentRange.yearMonth)
      : buildRange(_currentRange.days, _rangeEnd);
  }

  async function render() {
    var dates = currentDates();
    var store  = await harvest(dates);

    /* Check if any data exists */
    var hasAny = METRICS.some(function(m) {
      return m.forms.some(function(f) { return store[f] && Object.keys(store[f]).length > 0; });
    });

    var emptyEl   = document.getElementById('an-empty');
    var contentEl = document.getElementById('an-content');
    if (!hasAny) {
      if (emptyEl)   emptyEl.style.display   = 'flex';
      if (contentEl) contentEl.style.display = 'none';
      return;
    }
    if (emptyEl)   emptyEl.style.display   = 'none';
    if (contentEl) contentEl.style.display = 'block';

    updateCoverage(store, dates);

    /* Server-computed daily series (the formula engine — same registry).
       Where the server has a value for a date, it wins; dates it doesn't
       know (offline, demo-seeded local data) fall back to the SAME
       registry functions computed locally over the harvested store. */
    var serverByKey = {};
    if (window.NyatiAPI && NyatiAPI.getDailySeries) {
      try {
        var daily = await NyatiAPI.getDailySeries(dates[0], dates[dates.length - 1]);
        Object.keys(daily).forEach(function (key) {
          var byDate = {};
          (daily[key].series || []).forEach(function (p) { byDate[p.date] = p.value; });
          serverByKey[key] = byDate;
        });
      } catch (e) { /* offline — local registry compute below covers it */ }
    }

    var allAnomalies = [];

    METRICS.forEach(function(metric) {
      var serverSeries = serverByKey[metric.key] || {};
      var values = dates.map(function(date) {
        var sv = serverSeries[date];
        if (sv !== undefined && sv !== null) return sv;
        return metric.metric(store, date);
      });

      renderChart(metric, dates, values);

      /* Collect anomalies */
      var anom = anomalyMask(values);
      values.forEach(function(v, i) {
        if (v === null) return;

        var specFail = isViolation(v, metric.target, metric.targetDir);
        var statAnom = anom[i];

        if (specFail || statAnom) {
          allAnomalies.push({
            date:      dates[i],
            dateLabel: fmtDate(dates[i]),
            metric:    metric.label,
            value:     v.toFixed(metric.dec) + (metric.unit ? ' ' + metric.unit : ''),
            color:     metric.color,
            type:      specFail ? 'spec' : 'stat',
            note:      specFail
              ? 'Target: ' + (metric.targetDir || '') + ' ' + metric.target + (metric.unit ? ' ' + metric.unit : '')
              : 'Deviates > 1.8σ from period average',
          });
        }
      });
    });

    buildAnomalyTable(allAnomalies);
  }

  /* ── Demo data seed ──────────────────────────────────────────── */
  var _demoKeys = [];

  function seedDemoData() {
    /* Gaussian noise helper */
    function rnd(mean, sd) {
      var u = 1 - Math.random(), v = 1 - Math.random();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    /* Clear any previously seeded demo keys (tracked in _demoKeys) */
    _demoKeys.forEach(function(k) { localStorage.removeItem(k); });
    _demoKeys = [];

    var today = new Date();
    /* 28 days of demo data, skip 4 random days to simulate weekends */
    var skip = [3, 8, 14, 20];
    for (var d = 29; d >= 0; d--) {
      if (skip.indexOf(d) >= 0) continue;
      var date = new Date(today);
      date.setDate(date.getDate() - d);
      var iso = date.toISOString().slice(0, 10);

      /* Introduce a bad spell on days 10-13 for drama */
      var stressed = (d >= 10 && d <= 13);

      function setDemo(key, payload) {
        localStorage.setItem(key, JSON.stringify(payload));
        _demoKeys.push(key);
      }

      var qualityData = {
        free_lime:    rnd(stressed ? 3.6 : 2.5, 0.35).toFixed(2),
        blaine_425r:  Math.round(rnd(stressed ? 3280 : 3580, 95)),
        strength_28d: rnd(stressed ? 44.1 : 47.8, 1.4).toFixed(1),
        coal_residue: rnd(4.2, 0.4).toFixed(2),
        lsf_rm_h1: rnd(96.2, 0.8).toFixed(1), lsf_rm_h2: rnd(96.5, 0.8).toFixed(1),
        lsf_rm_h3: rnd(96.8, 0.7).toFixed(1), lsf_rm_h4: rnd(96.3, 0.9).toFixed(1),
        lsf_rm_h5: rnd(97.0, 0.7).toFixed(1), lsf_rm_h6: rnd(96.7, 0.8).toFixed(1),
      };
      setDemo('nyati-quality-' + iso, {
        _m: { formId: 'quality', date: iso, status: 'submitted', savedAt: iso + 'T08:30:00Z' },
        data: qualityData, inputs: [],
      });

      var cao_fields = {};
      for (var h = 1; h <= 18; h++) {
        cao_fields['cao_h' + h] = rnd(stressed ? 42.1 : 44.2, 0.6).toFixed(2);
      }
      setDemo('nyati-pile-quality-' + iso, {
        _m: { formId: 'pile-quality', date: iso, status: 'submitted', savedAt: iso + 'T07:00:00Z' },
        data: cao_fields, inputs: [],
      });

      var baseDispatch = rnd(stressed ? 310 : 390, 28);
      var dispReg = baseDispatch * 0.70, dispBlk = baseDispatch * 0.22, dispBag = baseDispatch * 0.08;
      setDemo('nyati-dispatch-' + iso, {
        _m: { formId: 'dispatch', date: iso, status: 'submitted', savedAt: iso + 'T18:00:00Z' },
        data: {
          /* three independently loaded channels, each broken down by grade */
          dispatch_reg_425r:    Math.max(0, rnd(dispReg * 0.60, 10)).toFixed(1),
          dispatch_reg_425nbm:  Math.max(0, rnd(dispReg * 0.05, 3)).toFixed(1),
          dispatch_reg_425n:    Math.max(0, rnd(dispReg * 0.25, 8)).toFixed(1),
          dispatch_reg_325n:    Math.max(0, rnd(dispReg * 0.07, 4)).toFixed(1),
          dispatch_reg_opc425n: Math.max(0, rnd(dispReg * 0.03, 2)).toFixed(1),
          dispatch_blk_425r:    Math.max(0, rnd(dispBlk * 0.55, 8)).toFixed(1),
          dispatch_blk_425nbm:  '0',
          dispatch_blk_425n:    Math.max(0, rnd(dispBlk * 0.30, 6)).toFixed(1),
          dispatch_blk_325n:    Math.max(0, rnd(dispBlk * 0.15, 4)).toFixed(1),
          dispatch_blk_opc425n: '0',
          dispatch_bag_425r:    Math.max(0, rnd(dispBag * 0.60, 4)).toFixed(1),
          dispatch_bag_425nbm:  Math.max(0, rnd(dispBag * 0.15, 2)).toFixed(1),
          dispatch_bag_425n:    Math.max(0, rnd(dispBag * 0.25, 3)).toFixed(1),
          dispatch_clinker:     '0',
        }, inputs: [],
      });

      var basePower = rnd(stressed ? 175000 : 158000, 6500);
      setDemo('nyati-power-cons-' + iso, {
        _m: { formId: 'power-cons', date: iso, status: 'submitted', savedAt: iso + 'T19:00:00Z' },
        data: {
          pwr_crusher_kwh:  Math.round(rnd(1600, 120)),
          pwr_rawmill_kwh:  Math.round(rnd(basePower * 0.326, 1800)),
          pwr_coalmill_kwh: Math.round(rnd(basePower * 0.069, 600)),
          pwr_kiln_kwh:     Math.round(rnd(basePower * 0.267, 1400)),
          pwr_cm2_kwh:      Math.round(rnd(basePower * 0.242, 1300)),
          pwr_packing_kwh:  Math.round(rnd(4200, 300)),
          pwr_lighting_kwh: Math.round(rnd(3500, 200)),
        }, inputs: [],
      });

      var clinkerProd = Math.round(rnd(stressed ? 1410 : 1620, 55));
      var coalCons    = Math.round(rnd(stressed ? 258 : 245, 12));
      var ncv         = Math.round(rnd(4850, 120));
      setDemo('nyati-production-' + iso, {
        _m: { formId: 'production', date: iso, status: 'submitted', savedAt: iso + 'T06:00:00Z' },
        data: {
          kiln_prod_mt:   clinkerProd,
          kiln_run_hrs:   (stressed ? rnd(20.5, 1.2) : 24).toFixed(2),
          kiln_coal_cons: coalCons,
          kiln_coal_ncv:  ncv,
        }, inputs: [],
      });
    }

    /* Banner */
    var banner = document.getElementById('_demo-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = '_demo-banner';
      banner.style.cssText = 'background:#FEF3C7;border-bottom:1px solid #FDE68A;padding:8px 28px;display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;color:#92400E';
      banner.innerHTML = '<span>⚠ Demo data loaded — submit real daily reports to populate with actual values.</span>' +
        '<button onclick="clearDemoData()" style="background:#92400E;color:white;border:none;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:700;cursor:pointer;font-family:Inter,sans-serif">Clear Demo</button>';
      document.querySelector('.an-period-bar').after(banner);
    }

    render();
  }

  window.clearDemoData = function() {
    _demoKeys.forEach(function(k) { localStorage.removeItem(k); });
    _demoKeys = [];
    var banner = document.getElementById('_demo-banner');
    if (banner) banner.remove();
    render();
  };

  window.seedDemoData = seedDemoData;

  /* ── Period pills ─────────────────────────────────────────────── */
  document.querySelectorAll('.an-pill').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.an-pill').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var monthInput = document.getElementById('an-month-input');
      if (monthInput) monthInput.value = '';
      _currentRange = { type: 'days', days: parseInt(btn.dataset.days, 10) };
      render();   // keeps whatever _rangeEnd the bootstrap resolved
    });
  });

  /* ── Month picker — pinned historical month, independent of "today" ── */
  var _monthInput = document.getElementById('an-month-input');
  if (_monthInput) {
    _monthInput.addEventListener('change', function() {
      if (!_monthInput.value) return;
      document.querySelectorAll('.an-pill').forEach(function(b) { b.classList.remove('active'); });
      _currentRange = { type: 'month', yearMonth: _monthInput.value };
      // A pinned month is the user's explicit choice — drop the fallback note.
      if (window.LatestPeriod) LatestPeriod.showNote('an-stale', null);
      render();
    });
  }

  /* ── Live date ────────────────────────────────────────────────── */
  var _dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric'
  });
  ['live-date', 'footer-date'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = _dateStr;
  });

  /* ── React to form submissions in other tabs ──────────────────── */
  window.addEventListener('storage', function(e) {
    if (e.key && e.key.startsWith('nyati-')) render();
  });

  /* ── Bootstrap ──────────────────────────────────────────────────
     Render immediately so the page is never blank, then — if nothing has
     been entered since an earlier date — slide the trailing window back to
     end there and say so, rather than showing 15 empty charts. */
  async function bootstrap() {
    render();
    if (!window.LatestPeriod) return;
    var r = await LatestPeriod.defaultRange(_currentRange.days || 30, null);
    if (!r.fellBack) return;
    _rangeEnd = r.to;
    LatestPeriod.showNote('an-stale', r);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

}());
