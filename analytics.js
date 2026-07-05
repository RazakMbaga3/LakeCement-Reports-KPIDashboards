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

  /* ── Date range builder ────────────────────────────────────────── */
  function buildRange(days) {
    var dates = [];
    var end   = new Date();
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(end);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  /* ══════════════════════════════════════════════════════════════
     METRIC DEFINITIONS
     metric(dayData) → number | null
  ══════════════════════════════════════════════════════════════ */
  var METRICS = [
    {
      id:     'free-cao',
      form:   'quality',
      label:  'Free CaO (%)',
      unit:   '%',
      dec:    2,
      metric: function(d) { return nvl(d.free_lime); },
      target: 3.0, targetDir: '<=', targetLabel: 'Spec 3.0%',
      color:  '#e53935', fillColor: 'rgba(229,57,53,0.08)',
    },
    {
      id:     'blaine',
      form:   'quality',
      label:  'Blaine 425R (cm²/g)',
      unit:   '',
      dec:    0,
      metric: function(d) { return nvl(d.blaine_425r); },
      target: 3500, targetDir: '>=', targetLabel: 'Min 3,500',
      color:  '#239557', fillColor: 'rgba(35,149,87,0.08)',
    },
    {
      id:     'strength',
      form:   'quality',
      label:  '28-Day Strength (MPa)',
      unit:   'MPa',
      dec:    1,
      metric: function(d) { return nvl(d.strength_28d); },
      target: 42.5, targetDir: '>=', targetLabel: 'Min 42.5',
      color:  '#4F74B2', fillColor: 'rgba(79,116,178,0.08)',
    },
    {
      id:     'pile-cao',
      form:   'pile-quality',
      label:  'Pile CaO Avg (%)',
      unit:   '%',
      dec:    2,
      metric: function(d) {
        var vals = [];
        for (var i = 1; i <= 18; i++) {
          var v = nvl(d['cao_h' + i]);
          if (v !== null && v > 0) vals.push(v);
        }
        return vals.length ? vals.reduce(function(a, b) { return a + b; }, 0) / vals.length : null;
      },
      target: 44.0, targetDir: '>=', targetLabel: 'Target 44%',
      color:  '#7c3aed', fillColor: 'rgba(124,58,237,0.08)',
    },
    {
      id:     'dispatch',
      form:   'dispatch',
      label:  'Daily Dispatch (MT)',
      unit:   'MT',
      dec:    1,
      metric: function(d) {
        var t = n(d.dispatch_425r) + n(d.dispatch_425n) + n(d.dispatch_bulker) + n(d.dispatch_bigbag);
        return t > 0 ? t : null;
      },
      target: null,
      color:  '#F49545', fillColor: 'rgba(244,149,69,0.08)',
    },
    {
      id:     'power',
      form:   'power-cons',
      label:  'Total Power (kWh)',
      unit:   'kWh',
      dec:    0,
      metric: function(d) {
        var t = n(d.pwr_crusher_kwh) + n(d.pwr_rawmill_kwh) + n(d.pwr_coalmill_kwh) +
                n(d.pwr_kiln_kwh)   + n(d.pwr_cm2_kwh)     + n(d.pwr_packing_kwh)  +
                n(d.pwr_utils_kwh)  + n(d.pwr_lighting_kwh);
        return t > 500 ? t : null;
      },
      target: null,
      color:  '#0d9488', fillColor: 'rgba(13,148,136,0.08)',
    },
    {
      id:     'clinker',
      form:   'kiln',
      label:  'Clinker Production (MT)',
      unit:   'MT',
      dec:    0,
      metric: function(d) { var v = nvl(d.kiln_prod_mt); return (v && v > 0) ? v : null; },
      target: 2000, targetDir: '>=', targetLabel: 'Target ≥ 2,000 MT/day',
      color:  '#F49545', fillColor: 'rgba(244,149,69,0.08)',
    },
    {
      id:     'sp-heat',
      form:   'kiln',
      label:  'Specific Heat (kcal/kg)',
      unit:   'kcal/kg',
      dec:    0,
      metric: function(d) {
        var prod = nvl(d.kiln_prod_mt), coal = nvl(d.kiln_coal_cons), ncv = nvl(d.kiln_coal_ncv);
        return (prod && prod > 0 && coal && coal > 0 && ncv && ncv > 0)
          ? coal * ncv * 1000 / prod : null;
      },
      target: 780, targetDir: '<=', targetLabel: 'Target < 780 kcal/kg',
      color:  '#7c3aed', fillColor: 'rgba(124,58,237,0.08)',
    },
  ];

  /* ── Harvest form data for the trend window ───────────────────────
     Per form: read local snapshots first (covers offline data AND
     seedDemoData(), which is intentionally local-only — see below),
     then overlay server records for the same date range, server taking
     precedence when both exist for a date. This is a merge, not a
     try-server-else-local fallback, specifically so demo data (which the
     server has never heard of and always returns "no rows" for) still
     renders — a thrown/failed server call falls back the same way. ──── */
  async function harvest(days) {
    var range   = buildRange(days);
    var cutoff  = range[0];
    var todayIso = range[range.length - 1];
    var forms = [];
    METRICS.forEach(function(m) { if (forms.indexOf(m.form) === -1) forms.push(m.form); });

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
    if (!goingUp && !goingDown) return { symbol: '→', color: '#94A3B8' };
    /* Color: green if direction matches target, red if against target */
    var good = targetDir === '>=' ? goingUp : (targetDir === '<=' ? goingDown : null);
    var color = good === null ? '#94A3B8' : (good ? '#239557' : '#e53935');
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
        '<td style="font-weight:700;color:' + a.color + '">' + a.value + '</td>' +
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
  function updateCoverage(store, days, dates) {
    var chips = document.getElementById('an-cov-chips');
    if (!chips) return;

    var defs = [
      { key: 'quality',      label: 'Quality' },
      { key: 'kiln',         label: 'Kiln' },
      { key: 'dispatch',     label: 'Dispatch' },
      { key: 'power-cons',   label: 'Power' },
      { key: 'pile-quality', label: 'Pile' },
    ];

    chips.innerHTML = defs.map(function(d) {
      var count = store[d.key] ? Object.keys(store[d.key]).length : 0;
      var pct   = Math.round(count / days * 100);
      var cls   = pct >= 70 ? 'an-cov-good' : (pct > 0 ? 'an-cov-fair' : 'an-cov-none');
      var dotC  = pct >= 70 ? '#239557' : (pct > 0 ? '#D97706' : '#CBD5E1');
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
    var kDays  = store['kiln']         ? Object.keys(store['kiln']).length          : 0;
    var el = document.getElementById('badge-quality');
    if (el) el.textContent = (qDays + pqDays) + ' form-days';
    el = document.getElementById('badge-production');
    if (el) el.textContent = kDays + ' form-days';
    el = document.getElementById('badge-operations');
    if (el) el.textContent = (dDays + pwDays) + ' form-days';
  }

  /* ═══════════════════════════════════════════════════════════════
     MAIN RENDER
  ═══════════════════════════════════════════════════════════════ */
  var _currentDays = 30;

  async function render(days) {
    _currentDays = days;
    var dates  = buildRange(days);
    var store  = await harvest(days);

    /* Check if any data exists */
    var hasAny = METRICS.some(function(m) { return store[m.form] && Object.keys(store[m.form]).length > 0; });

    var emptyEl   = document.getElementById('an-empty');
    var contentEl = document.getElementById('an-content');
    if (!hasAny) {
      if (emptyEl)   emptyEl.style.display   = 'flex';
      if (contentEl) contentEl.style.display = 'none';
      return;
    }
    if (emptyEl)   emptyEl.style.display   = 'none';
    if (contentEl) contentEl.style.display = 'block';

    updateCoverage(store, days, dates);

    var allAnomalies = [];

    METRICS.forEach(function(metric) {
      var formData = store[metric.form] || {};
      var values   = dates.map(function(date) {
        var day = formData[date];
        return day ? metric.metric(day) : null;
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
      setDemo('nyati-dispatch-' + iso, {
        _m: { formId: 'dispatch', date: iso, status: 'submitted', savedAt: iso + 'T18:00:00Z' },
        data: {
          dispatch_425r:   Math.max(0, rnd(baseDispatch * 0.55, 12)).toFixed(1),
          dispatch_425n:   Math.max(0, rnd(baseDispatch * 0.18, 8)).toFixed(1),
          dispatch_bulker: Math.max(0, rnd(baseDispatch * 0.20, 10)).toFixed(1),
          dispatch_bigbag: Math.max(0, rnd(baseDispatch * 0.07, 5)).toFixed(1),
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
          pwr_utils_kwh:    Math.round(rnd(4100, 250)),
          pwr_lighting_kwh: Math.round(rnd(3500, 200)),
        }, inputs: [],
      });

      var clinkerProd = Math.round(rnd(stressed ? 1410 : 1620, 55));
      var coalCons    = Math.round(rnd(stressed ? 258 : 245, 12));
      var ncv         = Math.round(rnd(4850, 120));
      setDemo('nyati-kiln-' + iso, {
        _m: { formId: 'kiln', date: iso, status: 'submitted', savedAt: iso + 'T06:00:00Z' },
        data: {
          kiln_prod_mt:   clinkerProd,
          kiln_run_hrs:   (stressed ? rnd(20.5, 1.2) : 24).toFixed(2),
          kiln_stop_min:  stressed ? Math.round(rnd(180, 60)) : 0,
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
      banner.style.cssText = 'background:#FEF3C7;border-bottom:1px solid #FDE68A;padding:8px 28px;display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;color:#92400E';
      banner.innerHTML = '<span>⚠ Demo data loaded — submit real daily reports to populate with actual values.</span>' +
        '<button onclick="clearDemoData()" style="background:#92400E;color:white;border:none;padding:4px 12px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;font-family:Inter,sans-serif">Clear Demo</button>';
      document.querySelector('.an-period-bar').after(banner);
    }

    render(_currentDays);
  }

  window.clearDemoData = function() {
    _demoKeys.forEach(function(k) { localStorage.removeItem(k); });
    _demoKeys = [];
    var banner = document.getElementById('_demo-banner');
    if (banner) banner.remove();
    render(_currentDays);
  };

  window.seedDemoData = seedDemoData;

  /* ── Period pills ─────────────────────────────────────────────── */
  document.querySelectorAll('.an-pill').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.an-pill').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      render(parseInt(btn.dataset.days, 10));
    });
  });

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
    if (e.key && e.key.startsWith('nyati-')) render(_currentDays);
  });

  /* ── Bootstrap ────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { render(30); });
  } else {
    render(30);
  }

}());
