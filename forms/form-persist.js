/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Form Persistence Layer  (Phase 1)
   ─────────────────────────────────────────────────────────────────
   What this does:
     • Save Draft   → writes all inputs to localStorage (browser notebook)
     • Load Previous → shows saved dates panel, restores chosen snapshot
     • Submit Report → marks as submitted + downloads dated JSON file
     • Auto-save     → silently saves every 60 s while form is open
     • On date change → auto-loads any saved data for that date
     • On page load  → restores today's data if it exists
     • Submitted     → form is locked so data cannot be altered after submit

   Usage (add to the bottom of every form page):
     <script src="form-persist.js"></script>
     <script>initFormPersist('form-id');</script>

   Storage key format: nyati-{formId}-{YYYY-MM-DD}
   ══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const NS = 'nyati'; // localStorage namespace prefix

  const _SEL = 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea';

  /* ── Collect all editable inputs — positional array + named dict ── */
  function _collect(scope) {
    const values = [];
    const named  = {};
    [...scope.querySelectorAll(_SEL)].forEach(el => {
      values.push(el.value);
      const f = el.getAttribute('data-field');
      if (f) named[f] = el.value;
    });
    return { values, named };
  }

  /* ── Clear: blank every editable input (leaves the date field alone —
     it already holds the newly-picked date). Used when switching to a
     date that has no saved snapshot, so stale values from the previously
     loaded date don't linger and get mistaken for that date's data. ──── */
  function _clearForm(scope) {
    [...scope.querySelectorAll(_SEL)].forEach(el => {
      if (el.type === 'date') return;
      el.value = '';
    });
    scope.querySelectorAll('.cao-input').forEach(inp => {
      inp.dispatchEvent(new Event('change'));
    });
    _syncDateChips(scope);
    document.dispatchEvent(new CustomEvent('nyati:restored'));
  }

  /* ── Restore: positional first, named fields override ───────────── */
  function _restore(scope, payload) {
    // Support both old format (plain array) and new format (object with inputs/data)
    const values = Array.isArray(payload) ? payload : (payload.inputs || []);
    const named  = Array.isArray(payload) ? {} : (payload.data || {});

    // Positional restore
    [...scope.querySelectorAll(_SEL)].forEach((el, i) => {
      if (i < values.length && values[i] !== undefined) el.value = values[i];
    });
    // Named override (more reliable, survives form edits)
    Object.entries(named).forEach(([field, value]) => {
      const el = scope.querySelector(`[data-field="${field}"]`);
      if (el) el.value = value;
    });
    // Re-trigger CaO spec check if pile-quality form
    scope.querySelectorAll('.cao-input').forEach(inp => {
      inp.dispatchEvent(new Event('change'));
    });
    _syncDateChips(scope);
    // Notify kpi-live.js that data has been restored
    document.dispatchEvent(new CustomEvent('nyati:restored'));
  }

  /* ── Get the toolbar date input value ──────────────────────────── */
  function _dateVal(scope) {
    const d = scope.querySelector('input[type="date"]');
    return d ? d.value : _todayStr();
  }

  const _MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* ── Sync stale "21-Apr-2026" / "Date: 03-May-2026" style chips ────
     Several report pages were built from an April-21-2026 mockup and
     ship a `.rcard-chip` per section whose text is the literal mockup
     date, never wired to anything — so switching the toolbar date
     updates the real KPI figures below it but this chip just sits
     there unchanged, making it look like nothing happened. Rewrites
     only chips that are ENTIRELY a recognizable date (optionally
     "Date: " prefixed) — leaves category chips like "ALL SECTIONS" or
     "PRODUCTION HEAD" untouched. */
  function _syncDateChips(scope) {
    const dateVal = _dateVal(scope);
    if (!dateVal) return;
    const d = new Date(dateVal + 'T00:00:00');
    if (isNaN(d)) return;
    const formatted = String(d.getDate()).padStart(2, '0') + '-' + _MON[d.getMonth()] + '-' + d.getFullYear();
    const dateChip = /^(\d{1,2}-[A-Za-z]{3}-\d{4})$/;
    const prefixedDateChip = /^(Date:\s*)\d{1,2}-[A-Za-z]{3}-\d{4}$/i;
    scope.querySelectorAll('.rcard-chip').forEach(el => {
      const t = el.textContent.trim();
      if (dateChip.test(t)) el.textContent = formatted;
      else if (prefixedDateChip.test(t)) el.textContent = t.replace(prefixedDateChip, '$1') + formatted;
    });
  }

  /* ── Today, as YYYY-MM-DD ─────────────────────────────────────── */
  function _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  /* ── localStorage key ───────────────────────────────────────────── */
  function _key(formId, date) {
    return `${NS}-${formId}-${date}`;
  }

  /* ── List all saved snapshots for a form, newest first ─────────── */
  function _allSaved(formId) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`${NS}-${formId}-`)) keys.push(k);
    }
    return keys.sort().reverse();
  }

  /* ── Write snapshot to localStorage ─────────────────────────────── */
  function _write(formId, status) {
    const date = _dateVal(document.body);
    const { values, named } = _collect(document.body);
    const payload = {
      _m: { formId, date, savedAt: new Date().toISOString(), status },
      inputs: values,   // positional array — backwards compat
      data:   named     // named dict — Phase 2 readable
    };
    localStorage.setItem(_key(formId, date), JSON.stringify(payload));
    return { date, payload };
  }

  /* ── Update "Last saved HH:MM" chip in toolbar ───────────────── */
  function _updateSavedChip(status) {
    let chip = document.getElementById('_ny-saved-chip');
    if (!chip) {
      chip = document.createElement('span');
      chip.id = '_ny-saved-chip';
      chip.style.cssText = 'font-size:10px;font-weight:600;color:var(--text-muted);white-space:nowrap;flex-shrink:0;transition:color .3s;padding:0 2px';
      // Insert between toolbar sep and btn-grp
      const grp = document.querySelector('.btn-grp');
      if (grp) grp.parentElement.insertBefore(chip, grp);
    }
    const t = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (status === 'submitted') {
      chip.style.color = 'var(--green)';
      chip.textContent = '✓ Submitted ' + t;
    } else {
      chip.style.color = 'var(--text-muted)';
      chip.textContent = 'Saved ' + t;
    }
  }

  /* ── Read snapshot — server first (source of truth), localStorage
     fallback (offline / server unreachable). Server records don't carry
     a draft/submitted distinction of their own (daily_reports has no
     status column), so that status rides along inside the JSONB `data`
     blob as `_status`, written by _syncToServer below. ─────────────── */
  async function _read(formId, date) {
    if (global.NyatiAPI) {
      try {
        const record = await global.NyatiAPI.getForm(formId, date);
        if (record && record.data) {
          const status = record.data._status || 'submitted';
          const payload = { _m: { formId, date, savedAt: record.updated_at || record.submitted_at, status }, inputs: [], data: record.data };
          _restore(document.body, payload);
          // Mirror into localStorage as an offline cache for _showHistory().
          localStorage.setItem(_key(formId, date), JSON.stringify(payload));
          return payload._m;
        }
      } catch (e) {
        // Server unreachable / error — fall through to localStorage.
      }
    }
    const raw = localStorage.getItem(_key(formId, date));
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      _restore(document.body, p);   // pass full payload — handles both formats
      return p._m;
    } catch (e) {
      return null;
    }
  }

  /* ── Sync a saved snapshot to the server. Best-effort: local save/lock
     UX always proceeds regardless of server reachability; this only adds
     durability on top of it. Retryable failures (offline, 401, 5xx) are
     handed to NyatiQueue, which auto-syncs when the server returns. ──── */
  async function _syncToServer(formId, date, named, status) {
    if (!global.NyatiAPI) return { ok: false, queued: false };
    const payload = Object.assign({}, named, { _status: status });
    try {
      await global.NyatiAPI.submitForm(formId, date, 'day', payload);
      return { ok: true };
    } catch (e) {
      const retryable = !e.status || e.status === 401 || e.status >= 500;
      if (retryable && global.NyatiQueue) {
        global.NyatiQueue.enqueue(formId, date, 'day', payload);
        return { ok: false, queued: true };
      }
      return { ok: false, queued: false, error: e };
    }
  }

  /* ── Toast notification ──────────────────────────────────────────── */
  function _toast(msg, type) {
    type = type || 'ok';
    document.getElementById('_nyt')?.remove();

    const colors = { ok: '#239557', warn: '#D97706', err: '#DC2626' };
    const icons  = { ok: '✓',       warn: '⚠',       err: '✕'      };

    if (!document.getElementById('_nyt-css')) {
      const s = document.createElement('style');
      s.id = '_nyt-css';
      s.textContent = '@keyframes _nytIn{from{transform:translateY(14px);opacity:0}to{transform:translateY(0);opacity:1}}';
      document.head.appendChild(s);
    }

    const el = document.createElement('div');
    el.id = '_nyt';
    el.innerHTML = `<span style="font-size:15px;flex-shrink:0">${icons[type]}</span><span>${msg}</span>`;
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '9999',
      background: colors[type], color: 'white',
      padding: '11px 20px', borderRadius: '9px',
      fontFamily: 'Inter,sans-serif', fontSize: '13px', fontWeight: '600',
      boxShadow: '0 4px 24px rgba(0,0,0,.22)',
      display: 'flex', alignItems: 'center', gap: '10px',
      animation: '_nytIn .2s ease', maxWidth: '360px'
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  /* ── History panel (shown on "Load Previous") ───────────────────── */
  function _showHistory(formId, anchor) {
    document.getElementById('_nyh')?.remove();

    const saved = _allSaved(formId);
    const rect  = anchor.getBoundingClientRect();

    const panel = document.createElement('div');
    panel.id = '_nyh';
    Object.assign(panel.style, {
      position: 'fixed',
      top:  Math.min(rect.bottom + 6, window.innerHeight - 320) + 'px',
      left: Math.max(rect.left, 8) + 'px',
      zIndex: '9998', background: 'white',
      border: '1.5px solid #DDE3EC', borderRadius: '10px',
      boxShadow: '0 8px 36px rgba(0,0,0,.16)',
      minWidth: '260px', maxWidth: '320px',
      fontFamily: 'Inter,sans-serif', overflow: 'hidden'
    });

    // Header
    const hdr = document.createElement('div');
    hdr.style.cssText = 'background:#173158;color:white;padding:10px 14px;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center';
    hdr.innerHTML = `<span>Saved Snapshots</span><span style="font-size:10px;opacity:.6">${saved.length} saved</span>`;
    panel.appendChild(hdr);

    if (saved.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:20px 14px;font-size:12px;color:#94A3B8;text-align:center;line-height:1.6';
      empty.innerHTML = 'No drafts saved yet.<br>Fill the form and click <strong>Save Draft</strong>.';
      panel.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.style.cssText = 'max-height:240px;overflow-y:auto';

      saved.forEach(key => {
        let meta = null;
        try { meta = JSON.parse(localStorage.getItem(key) || '{}')._m; } catch (e) {}

        const date   = meta?.date   || key.replace(`${NS}-${formId}-`, '');
        const status = meta?.status || 'draft';
        const time   = meta?.savedAt
          ? new Date(meta.savedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
          : '';

        const badgeStyle = status === 'submitted'
          ? 'background:#BBF7D0;color:#14532D'
          : 'background:#FEF3C7;color:#92400E';

        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 14px;cursor:pointer;border-bottom:1px solid #F0F4F8;display:flex;justify-content:space-between;align-items:center;transition:background .1s';
        row.onmouseenter = () => (row.style.background = '#EFF6FF');
        row.onmouseleave = () => (row.style.background = '');
        row.innerHTML = `
          <span style="font-weight:600;color:#173158;font-size:12px">${date}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="color:#94A3B8;font-size:10px">${time}</span>
            <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;${badgeStyle}">${status.toUpperCase()}</span>
          </div>`;
        row.onclick = async () => {
          const loadedMeta = await _read(formId, date);
          if (loadedMeta) {
            _toast(`Loaded ${loadedMeta.status} — ${loadedMeta.date}`, 'ok');
            // Lock if submitted
            if (loadedMeta.status === 'submitted') _lockForm();
          }
          panel.remove();
        };
        list.appendChild(row);
      });
      panel.appendChild(list);
    }

    // Footer close
    const foot = document.createElement('div');
    foot.style.cssText = 'padding:9px 14px;text-align:center;font-size:11px;color:#94A3B8;cursor:pointer;background:#F7F8FA;border-top:1px solid #EEF2F7';
    foot.textContent = '✕  Close';
    foot.onclick = () => panel.remove();
    panel.appendChild(foot);

    document.body.appendChild(panel);

    // Click outside to dismiss
    setTimeout(() => {
      document.addEventListener('click', function dismiss(e) {
        if (!panel.contains(e.target) && e.target !== anchor) {
          panel.remove();
          document.removeEventListener('click', dismiss);
        }
      });
    }, 80);
  }

  /* ── Lock form after submission ──────────────────────────────────── */
  function _lockForm() {
    document.querySelectorAll('.ci, .tb-ctl').forEach(inp => {
      // The date picker itself stays live — locking it would trap the
      // user on this date with no way to move to a fresh, unsubmitted one.
      if (inp.type === 'date') return;
      inp.setAttribute('readonly', '');
      inp.style.opacity  = '.65';
      inp.style.cursor   = 'not-allowed';
      inp.style.pointerEvents = 'none';
    });
    document.querySelectorAll('.btn-save, .btn-sub').forEach(b => {
      b.disabled = true;
      b.style.opacity = '.45';
      b.style.cursor  = 'not-allowed';
    });

    // Submitted banner
    if (!document.getElementById('_nyb')) {
      const banner = document.createElement('div');
      banner.id = '_nyb';
      banner.innerHTML =
        '<span>✓ &nbsp;Report Submitted &amp; Locked — JSON file downloaded to your computer</span>' +
        '<button onclick="document.getElementById(\'_nyb\').remove()" title="Dismiss" style="' +
          'position:absolute;right:12px;top:50%;transform:translateY(-50%);' +
          'background:rgba(255,255,255,.25);border:none;color:white;width:22px;height:22px;' +
          'border-radius:50%;cursor:pointer;font-size:14px;line-height:1;display:flex;' +
          'align-items:center;justify-content:center;font-family:inherit' +
        '">×</button>';
      Object.assign(banner.style, {
        position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9997',
        background: '#239557', color: 'white', padding: '9px 48px 9px 16px',
        textAlign: 'center', fontFamily: 'Inter,sans-serif',
        fontSize: '12px', fontWeight: '700', letterSpacing: '.3px'
      });
      document.body.prepend(banner);
    }
  }

  /* ── Unlock form — reverses _lockForm(), used when the date is
     changed away from a previously-submitted date. ─────────────────── */
  function _unlockForm() {
    document.querySelectorAll('.ci, .tb-ctl').forEach(inp => {
      inp.removeAttribute('readonly');
      inp.style.opacity = '';
      inp.style.cursor  = '';
      inp.style.pointerEvents = '';
    });
    document.querySelectorAll('.btn-save, .btn-sub').forEach(b => {
      b.disabled = false;
      b.style.opacity = '';
      b.style.cursor  = '';
    });
    document.getElementById('_nyb')?.remove();
  }

  /* ── Sync the toolbar DRAFT/SUBMITTED pill to the real status ──────── */
  function _updateStatusPill(status) {
    const pill = document.querySelector('.rpt-pill');
    if (!pill) return;
    const submitted = status === 'submitted';
    pill.textContent = submitted ? 'SUBMITTED' : 'DRAFT';
    pill.classList.toggle('is-submitted', submitted);
  }

  /* ── Anomaly check at submit time ─────────────────────────────────
     Compares the entry against the 30-day per-field baseline from the
     server and returns human-readable warnings for values outside
     mean ± 2σ (with a 10% relative floor so tight-σ fields don't nag).
     Purely advisory — never blocks; offline/timeout → no warnings. */
  async function _unusualValues(formId, named) {
    if (!global.NyatiAPI || !global.NyatiAPI.getBaseline) return [];
    let baseline;
    try {
      baseline = await Promise.race([
        global.NyatiAPI.getBaseline(formId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
      ]);
    } catch (e) {
      return []; // offline or slow — data quality prompt is best-effort
    }
    const warnings = [];
    for (const [field, raw] of Object.entries(named || {})) {
      if (field.startsWith('_')) continue;
      const v = parseFloat(raw);
      const s = baseline.fields && baseline.fields[field];
      if (isNaN(v) || !s || s.n < 5 || s.mean === 0) continue;
      const dev    = Math.abs(v - s.mean);
      const relPct = (dev / Math.abs(s.mean)) * 100;
      const beyondBand = s.sd > 0 ? dev > 2 * s.sd : relPct > 30;
      if (beyondBand && relPct >= 10) {
        warnings.push(`• ${field}: ${v} is ${Math.round(relPct)}% ${v > s.mean ? 'above' : 'below'} the 30-day average (${s.mean.toLocaleString('en-US', { maximumFractionDigits: 1 })})`);
      }
      if (warnings.length >= 4) break;
    }
    return warnings;
  }

  /* ══ Public entry point ════════════════════════════════════════════ */
  global.initFormPersist = function (formId) {
    global._nyatiFormId = formId;
    const body      = document.body;
    const dateInput = body.querySelector('input[type="date"]');

    /* Default to today, not whatever demo date is baked into the HTML —
       a daily report should open on the current day, every day. */
    if (dateInput && !dateInput.value) {
      dateInput.value = _todayStr();
    }

    /* Save Draft — saves locally immediately, syncs to server best-effort */
    body.querySelectorAll('.btn-save').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.preventDefault();
        const { date, payload } = _write(formId, 'draft');
        _toast(`Draft saved — ${date}`, 'ok');
        _updateSavedChip('draft');
        _updateStatusPill('draft');
        document.dispatchEvent(new CustomEvent('nyati:saved', { detail: { formId, date } }));

        const sync = await _syncToServer(formId, date, payload.data, 'draft');
        if (!sync.ok) {
          _toast(sync.queued
            ? `Saved locally — offline, queued for auto-sync`
            : `Saved locally — server rejected the sync (check your access)`, 'warn');
        }
      });
    });

    /* Load Previous */
    body.querySelectorAll('.btn-out').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        _showHistory(formId, btn);
      });
    });

    /* Submit Report — local save + JSON download + lock happen regardless
       of server reachability (never lose the existing guarantee); the
       server call adds durability on top. */
    body.querySelectorAll('.btn-sub').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.preventDefault();
        const date = _dateVal(body);

        // Data-quality prompt: flag values far outside the 30-day norm
        const { named } = _collect(document.body);
        const unusual = await _unusualValues(formId, named);
        const warnBlock = unusual.length
          ? `⚠ UNUSUAL VALUES — please double-check:\n${unusual.join('\n')}\n\n`
          : '';

        if (!confirm(
          warnBlock +
          `Submit the ${formId} report for ${date}?\n\n` +
          `• A JSON file will download to your computer.\n` +
          `• The form will be locked against further edits.\n\n` +
          `Continue?`
        )) return;

        // Save as submitted then download
        const { payload } = _write(formId, 'submitted');
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = `nyati-${formId}-${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);

        _lockForm();
        _updateSavedChip('submitted');
        _updateStatusPill('submitted');
        document.dispatchEvent(new CustomEvent('nyati:submitted', { detail: { formId, date } }));

        const sync = await _syncToServer(formId, date, payload.data, 'submitted');
        if (sync.ok) {
          _toast(`Report submitted — nyati-${formId}-${date}.json downloaded`, 'ok');
        } else if (sync.queued) {
          _toast(`Submitted locally — server offline, queued for auto-sync`, 'warn');
        } else {
          _toast(`Submitted & downloaded locally — the server REJECTED it. Contact IT.`, 'err');
        }
      });
    });

    /* On date change → load saved data for that date, or start a clean
       draft if none exists. Always unlock first: a date switch away from
       a submitted day must never leave the new day's fields frozen. */
    if (dateInput) {
      dateInput.addEventListener('change', async () => {
        _unlockForm();
        const meta = await _read(formId, dateInput.value);
        if (meta) {
          _toast(`Loaded ${meta.status} — ${meta.date}`, 'ok');
          _updateStatusPill(meta.status);
          if (meta.status === 'submitted') _lockForm();
        } else {
          _clearForm(body);
          _updateStatusPill('draft');
        }
      });
    }

    /* Auto-save every 60 seconds (silent, local-only — draft autosave does
       not hit the server; only explicit Save Draft / Submit clicks do, to
       avoid unattended-tab write load and audit-log noise). */
    setInterval(() => {
      if (!document.querySelector('.btn-sub[disabled]')) {
        _write(formId, 'draft');
        _updateSavedChip('draft');
        document.dispatchEvent(new CustomEvent('nyati:saved', { detail: { formId } }));
      }
    }, 60000);

    /* On page load → silently restore today's data if saved, and reflect
       the real status on the toolbar pill (was previously stuck on the
       static "DRAFT" text baked into the HTML). */
    if (dateInput && dateInput.value) {
      _read(formId, dateInput.value).then(meta => {
        _updateStatusPill(meta ? meta.status : 'draft');
        if (meta && meta.status === 'submitted') _lockForm();
      });
    }
  };

}(window));
