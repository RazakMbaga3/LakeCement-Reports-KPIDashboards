/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Form Persistence Layer  (Phase 1)
   ─────────────────────────────────────────────────────────────────
   What this does:
     • Save Draft   → writes all inputs to localStorage (browser notebook)
                      and sends them to the server as a draft
     • Load Previous → lists every saved day — the server's records merged
                      with this browser's snapshots — and opens the chosen one
     • Submit Report → marks as submitted + downloads dated JSON file
     • Auto-save     → keeps every real edit on this device within a second and
                      sends it to the server ~20 s after typing stops (drafts
                      only; never touches a submitted/approved report)
     • Save state    → a toolbar chip says whether the work is unsaved, saved to
                      the server, or on this device only
     • On date change → keeps unsaved work as a draft, then loads that day
     • On page load  → restores today's data if it exists, puts back typed work
                      that never reached the server, and lists this form's other
                      unfinished days in a banner
     • Unnamed inputs → get a structural data-field so they persist too
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

  /* ── Controls that are NOT report data ────────────────────────────
     An input carrying data-nopersist (or sitting inside something that
     does), or owned by another engine (data-inline — inline-edit.js saves
     those to its own form type), is never named, saved or restored: the
     "e-mail this report to…" box, the "name the fault" box on the stoppage
     form, and so on. The two class names are matched as well so a browser
     still holding an older cached copy of excel-export.js /
     stoppage-reasons.js (JavaScript is cached for a day) behaves. */
  const _UI_ONLY = '[data-nopersist], [data-inline], .exp-email-in, .rsn-add-in';

  /* ── Unnamed inputs get a name ─────────────────────────────────────
     Everything the server stores, and everything another device gets back,
     travels by data-field. An input without one was persisted only as its
     POSITION in a localStorage array — invisible to the server, and skipped
     the moment a server record existed (that restore is name-only). So a
     draft "reloaded fine" while quietly dropping every unnamed cell: 131 of
     the pile-quality form's 151 inputs, 42 on Production, 38 on Dispatch, 33
     on Power Cons — the pile log, the dispatch log rows, the sign-off names.

     Rather than hand-name ~300 inputs across ten pages (and every future
     one), each unnamed input is given a STRUCTURAL name the first time it is
     seen: its table's id, its row and its cell (`_a_pile-log-tbl_r3_c2`) or,
     outside a table, its class + placeholder. Structural, not a running
     count, so adding an unrelated table elsewhere on the page cannot shift
     it. The leading underscore is the server's own convention for internal
     keys: the MIS pack, the approvals list and the anomaly baseline all skip
     them, so these never masquerade as KPI facts.

     It must run BEFORE mobile-entry.js relocates inputs into cards (which
     happens on DOMContentLoaded, after every inline initFormPersist call —
     so calling this first thing in initFormPersist is early enough) and
     again whenever a page adds rows by script (see the observer below). */
  function _slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  function _persistable(el) {
    return el.type !== 'date' && !el.matches(_UI_ONLY) && !el.closest('[data-nopersist]')
        && !el.hasAttribute('data-auto-computed');
  }

  function _autoKey(el, seen) {
    const cell = el.closest('td, th');
    const row  = cell && cell.parentElement;
    const tbl  = row && row.closest('table');
    let key;
    if (el.id) {
      key = '_a_id_' + _slug(el.id);
    } else if (tbl && row) {
      const tid   = tbl.id ? _slug(tbl.id) : 't' + [...document.querySelectorAll('table')].indexOf(tbl);
      const mates = [...cell.querySelectorAll(_SEL)];
      key = '_a_' + tid + '_r' + row.rowIndex + '_c' + cell.cellIndex + (mates.length > 1 ? '_' + mates.indexOf(el) : '');
    } else {
      key = '_a_' + (_slug((el.classList[0] || el.tagName) + '-' + (el.placeholder || el.type)) || 'x');
    }
    let k = key, n = 1;
    while (seen.has(k)) k = key + '_' + (++n);
    return k;
  }

  function _nameAnonymous(scope) {
    const seen = new Set();
    scope.querySelectorAll('[data-field]').forEach(el => seen.add(el.getAttribute('data-field')));
    scope.querySelectorAll(_SEL).forEach(el => {
      if (el.hasAttribute('data-field') || !_persistable(el)) return;
      const key = _autoKey(el, seen);
      seen.add(key);
      el.setAttribute('data-field', key);
      el.setAttribute('data-field-auto', '1');
    });
  }

  /* ── Collect all editable inputs — positional array + named dict ── */
  function _collect(scope) {
    _nameAnonymous(scope);
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
     loaded date don't linger and get mistaken for that date's data.

     `data-default` is the exception, and it exists because blanking
     everything is also wrong. These report pages were built from an
     April-2026 mockup (see _syncDateChips below) and ship with values
     typed into the markup. Two different kinds of value got mixed up in
     there: SEEDED MOCKUP FIGURES — one day's dispatch tonnages, bag
     counts, burst rates — which must never appear again, and STANDING
     BUSINESS DEFAULTS like the month's dispatch plan or a line's target
     bags/day, which are the correct starting point for every new report
     and which a blanket clear would silently throw away, leaving the
     month's plan empty and every MTD-achievement figure unable to
     compute. So the mockup figures have been removed from the markup at
     source, and the values that legitimately belong there now declare
     themselves with data-default="…" and survive a clear. ───────────── */
  function _clearForm(scope) {
    [...scope.querySelectorAll(_SEL)].forEach(el => {
      if (el.type === 'date') return;
      el.value = el.hasAttribute('data-default') ? el.getAttribute('data-default') : '';
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

    /* A page that adds rows by script (the pile log's "Add pile row") must
       be able to grow them BEFORE their values are laid down, or the values
       for row 19 onward have nowhere to land. It reads the field names in
       detail.data, adds what it needs, and the new inputs are named below. */
    document.dispatchEvent(new CustomEvent('nyati:before-restore', { detail: { data: named } }));
    _nameAnonymous(scope);

    /* Positional restore — ONLY when the form still has exactly as many
       inputs as the snapshot was taken from. The index of an input is only
       meaningful while the markup is unchanged; once a form gains or loses
       fields every later value lands in the wrong box, silently, and looks
       like real data. The stoppage form went from ~60 inputs to ~480 when
       its free-text event rows became the reason catalogue, which would
       have poured one report's figures across another report's rows.
       `data` (data-field) is keyed by name and restores regardless. */
    const els = [...scope.querySelectorAll(_SEL)];
    if (values.length === els.length) {
      els.forEach((el, i) => {
        if (values[i] !== undefined) el.value = values[i];
      });
    }
    // Named override (more reliable, survives form edits). One pass over the
    // page to index the fields, then a lookup per value — and no selector
    // built from a stored key, which a stray quote in a key could break.
    const byField = new Map();
    scope.querySelectorAll('[data-field]').forEach(el => {
      const f = el.getAttribute('data-field');
      if (!byField.has(f)) byField.set(f, el);
    });
    Object.entries(named).forEach(([field, value]) => {
      const el = byField.get(field);
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
     "PRODUCTION HEAD" untouched.

     `data-report-date` is the way OUT of that pattern-matching: an element
     carrying it is declared to be the report date and is rewritten
     whatever it currently says, so a page can ship an em-dash placeholder
     instead of a mockup date that is wrong until the first sync runs (and
     stays wrong forever on any page this function is not reached on).
     forms/quality-form.html uses it; the regex branches stay for the
     pages still carrying literal mockup dates. */
  function _syncDateChips(scope) {
    const dateVal = _dateVal(scope);
    if (!dateVal) return;
    const d = new Date(dateVal + 'T00:00:00');
    if (isNaN(d)) return;
    const formatted = String(d.getDate()).padStart(2, '0') + '-' + _MON[d.getMonth()] + '-' + d.getFullYear();
    const dateChip = /^(\d{1,2}-[A-Za-z]{3}-\d{4})$/;
    const prefixedDateChip = /^(Date:\s*)\d{1,2}-[A-Za-z]{3}-\d{4}$/i;
    scope.querySelectorAll('[data-report-date]').forEach(el => { el.textContent = formatted; });
    scope.querySelectorAll('.rcard-chip').forEach(el => {
      if (el.hasAttribute('data-report-date')) return;   // already handled above
      const t = el.textContent.trim();
      if (dateChip.test(t)) el.textContent = formatted;
      else if (prefixedDateChip.test(t)) el.textContent = t.replace(prefixedDateChip, '$1') + formatted;
    });
  }

  /* ── Today, as YYYY-MM-DD ───────────────────────────────────────
     Local calendar date, never toISOString(): EAT is UTC+3, so between
     local midnight and 03:00 the UTC date is still yesterday and every
     form would open on — and save to — the wrong day. */
  function _todayStr() {
    const d = new Date();
    const p2 = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  /* ── Report status ───────────────────────────────────────────────
     daily_reports.status (migration 010) has four values; this layer used
     to know only two, and read them from a `_status` key it wrote into the
     data blob itself. So a report awaiting an HOD's signature looked
     identical to an approved one, and a REJECTED report still showed
     "Submitted & Locked" — no reason, no way to correct and resend, the
     author never learning it had been turned back. */
  const STATUS_META = {
    draft: {
      pill: 'DRAFT', locked: false,
      chip: 'Saved', banner: null,
    },
    pending_approval: {
      pill: 'AWAITING SIGN-OFF', locked: true,
      chip: '✓ Submitted',
      banner: { bg: '#D97706', text: 'Submitted — waiting for your HOD to sign off. It is not counted as approved yet.' },
    },
    approved: {
      pill: 'APPROVED', locked: true,
      chip: '✓ Approved',
      banner: { bg: '#239557', text: '✓  Report submitted and approved.' },
    },
    rejected: {
      pill: 'REJECTED', locked: false,
      chip: '✕ Rejected',
      banner: { bg: '#DC2626', text: 'Rejected by your HOD — correct the figures and submit again.' },
    },
  };
  /* 'submitted' is what this layer wrote before the approval workflow
     existed, and all it means is "this device sent it". A server record
     always carries the real column now, so this mapping only applies to the
     offline localStorage fallback — where claiming 'approved' would tell
     someone their report is signed off when nothing has confirmed it.
     'pending_approval' is the honest reading: sent, outcome unknown here. */
  function _normaliseStatus(status) {
    if (status === 'submitted') return 'pending_approval';
    return STATUS_META[status] ? status : 'draft';
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

  /* ── The form's live state ───────────────────────────────────────
     One form per page, so this lives at module level and the status
     helpers below can update it without being handed a context. */
  const S = {
    formId: null,
    loadedDate: null,     // the day whose report is on screen right now
    loadToken: 0,         // bumped per load, so a slow load that was superseded is ignored
    status: 'draft', editable: true,
    dirty: false,         // typed since the last confirmed save to the server
    dirtySince: 0, editVersion: 0,
    inflight: false,
    serverHasRow: false,  // the server already holds a record for the loaded day
    stopped: false,       // the server refused an autosave for good — keep local, stop retrying
    failed: false,        // the last server attempt failed for a reason that may pass (offline, 5xx)
    localTimer: null, serverTimer: null, retryMs: 20000,
    flushedVersion: -1,   // editVersion last sent by the hide/close flush, so its two triggers don't double-send
    handedOff: null,      // a day whose unsaved work was just kept as a draft on the way to another day
  };

  function _localSnap(formId, date) {
    try { return JSON.parse(localStorage.getItem(_key(formId, date)) || 'null'); } catch (e) { return null; }
  }

  /* ── Write snapshot to localStorage ───────────────────────────────
     `unsynced` marks a snapshot the server has not confirmed yet. That flag
     is what lets a later visit recognise typed-but-never-sent work and put it
     back (see _load) instead of overwriting it with an older server copy.
     `date` writes the snapshot under a day other than the one in the date
     field — used when the date has just been changed but the form still
     shows the previous day's figures. */
  function _write(formId, status, opts) {
    opts = opts || {};
    const date = opts.date || _dateVal(document.body);
    const { values, named } = _collect(document.body);
    if (opts.date && 'date' in named) named.date = opts.date;
    const payload = {
      _m: { formId, date, savedAt: new Date().toISOString(), status, unsynced: !!opts.unsynced },
      inputs: values,   // positional array — backwards compat
      data:   named     // named dict — Phase 2 readable
    };
    try { localStorage.setItem(_key(formId, date), JSON.stringify(payload)); }
    catch (e) { /* storage full or blocked — the server copy is what counts */ }
    return { date, payload };
  }

  function _markSynced(formId, date) {
    const snap = _localSnap(formId, date);
    if (!snap || !snap._m || !snap._m.unsynced) return;
    snap._m.unsynced = false;
    try { localStorage.setItem(_key(formId, date), JSON.stringify(snap)); } catch (e) { /* see _write */ }
  }

  /* ── The save-state chip in the toolbar ──────────────────────────
     It used to read "Saved 14:02" the moment the browser wrote localStorage,
     whether or not anything had reached the server. It now says which of the
     things a person actually needs to know is true. */
  const _CHIP = {
    dirty:     ['var(--st-warn)',   'Unsaved changes',
                'Saved to the server automatically a few seconds after you stop typing.'],
    saving:    ['var(--text-muted)', 'Saving…', ''],
    device:    ['var(--st-warn)',   'Saved on this device only',
                'The server has not received the latest changes yet. They are kept here and sent automatically as soon as it can be reached.'],
    recovered: ['var(--st-warn)',   'Unsent changes recovered',
                'These changes were typed earlier and never reached the server. They are being sent now.'],
  };

  function _setChip(state, at) {
    let chip = document.getElementById('_ny-saved-chip');
    if (!chip) {
      chip = document.createElement('span');
      chip.id = '_ny-saved-chip';
      chip.setAttribute('role', 'status');
      chip.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-muted);white-space:nowrap;flex-shrink:0;transition:color .3s;padding:0 2px';
      // Insert between toolbar sep and btn-grp
      const grp = document.querySelector('.btn-grp');
      if (grp) grp.parentElement.insertBefore(chip, grp);
    }
    if (state === 'none') { chip.textContent = ''; chip.removeAttribute('title'); return; }
    const t = new Date(at || Date.now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (state === 'server' || state === 'submitted') {
      chip.style.color = 'var(--st-good)';
      chip.textContent = (state === 'submitted' ? '✓ Submitted ' : '✓ Saved ') + t;
      chip.title = state === 'submitted' ? '' : 'Saved to the server.';
      return;
    }
    const look = _CHIP[state];
    if (!look) return;
    chip.style.color = look[0];
    chip.textContent = look[1];
    chip.title = look[2];
  }

  /* ── Load a day — server first (source of truth), this device second.

     The status comes from the record's own `status` column. It used to be
     read from a `_status` key this file wrote into the data blob, which
     predates the approval workflow — so the server could say
     'pending_approval' or 'rejected' and the form would still render the
     author's own optimistic "submitted".

     Typed work is never thrown away in favour of an older server copy: if
     this device holds a snapshot the server never confirmed AND it is newer
     than the server's record AND the server's report is still editable, that
     snapshot wins ('recovered') and is sent up again. Before this, opening
     the page overwrote it with whatever the server had. ─────────────────── */
  async function _load(formId, date) {
    const local = _localSnap(formId, date);
    const snap  = local && local._m ? local : null;
    let record = null, reached = false;
    if (global.NyatiAPI) {
      try { record = await global.NyatiAPI.getForm(formId, date); reached = true; }
      catch (e) { /* offline or refused — fall back to this device's copy */ }
    }
    if (record && record.data) {
      const status = _normaliseStatus(record.status || record.data._status);
      const at     = record.updated_at || record.submitted_at;
      const meta   = { formId, date, savedAt: at, status, rejectionReason: record.rejection_reason || null, unsynced: false };
      if (snap && snap._m.unsynced && !STATUS_META[status].locked
          && (Date.parse(snap._m.savedAt) || 0) > (Date.parse(at) || 0)) {
        return { source: 'recovered', payload: snap, reached, serverRow: true,
                 meta: Object.assign({}, snap._m, { status, rejectionReason: meta.rejectionReason }) };
      }
      return { source: 'server', payload: { _m: meta, inputs: [], data: record.data }, meta, reached, serverRow: true };
    }
    if (snap) return { source: 'local', payload: snap, meta: snap._m, reached, serverRow: false };
    return { source: 'none', meta: null, reached, serverRow: false };
  }

  function _applyLoaded(formId, date, res) {
    if (res.source === 'none') return null;
    _restore(document.body, res.payload);
    if (res.source === 'server') {
      // Mirror into localStorage as an offline cache for _showHistory().
      try { localStorage.setItem(_key(formId, date), JSON.stringify(res.payload)); } catch (e) { /* see _write */ }
    }
    return res.meta;
  }

  /* ── Sync a saved snapshot to the server. Best-effort: local save/lock
     UX always proceeds regardless of server reachability; this only adds
     durability on top of it.

     An explicit save that fails for a retryable reason (offline, 401, 5xx)
     is handed to NyatiQueue, which auto-syncs when the server returns. An
     AUTOSAVE never is: it retries by itself, and a queued copy would only
     come back later as a spurious "newer version on the server" conflict
     against the autosave that finally got through. ──────────────────────── */
  async function _syncToServer(formId, date, named, status, opts) {
    opts = opts || {};
    if (!global.NyatiAPI) return { ok: false, queued: false, retry: true };
    /* `_status` is kept in the blob for the offline queue and for older
       records, but the server now decides the real status from the intent
       declared alongside the payload — a draft must never enter an HOD's
       approval queue or be self-certified as approved. */
    const payload = Object.assign({}, named, { _status: status });
    const intent  = status === 'submitted' ? 'submitted' : 'draft';
    try {
      const res = await global.NyatiAPI.submitForm(formId, date, 'day', payload,
        { status: intent, autosave: !!opts.autosave, keepalive: !!opts.keepalive });
      /* Whatever the server now holds supersedes any copy still waiting in the
         offline queue for this same day. */
      if (global.NyatiQueue && typeof global.NyatiQueue.discard === 'function') {
        global.NyatiQueue.discard(formId, date, 'day');
      }
      /* The server's answer is authoritative: an Officer's submission comes
         back 'pending_approval', not 'approved'. */
      return { ok: true, status: (res && res.record && res.record.status) || null };
    } catch (e) {
      const retryable = !e.status || e.status === 401 || e.status >= 500;
      if (opts.autosave) {
        return { ok: false, locked: e.status === 409, retry: retryable || e.status === 429, error: e };
      }
      if (retryable && global.NyatiQueue) {
        global.NyatiQueue.enqueue(formId, date, 'day', payload);
        return { ok: false, queued: true };
      }
      return { ok: false, queued: false, error: e };
    }
  }

  /* ── Toast notification ──────────────────────────────────────────── */
  function _toast(msg, type, ms) {
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
    setTimeout(() => el.remove(), ms || 3400);
  }

  /* ── History panel (shown on "Load Previous") ───────────────────────
     Lists every day this form has a saved record for: the SERVER's list
     merged with this browser's own snapshots.

     It used to list localStorage alone. A draft saved from another PC, a
     phone, a browser whose site data had been cleared, or the other address
     of the app (http vs https, IP vs domain — each is its own origin with
     its own storage) therefore read "No drafts saved yet" while sitting on
     the server the whole time, and its author took it for lost. Entries that
     only this browser holds are flagged instead, because that is the other
     thing a person needs to know: they never reached the server. */
  const _HISTORY_LIMIT = 120;

  /* Did a person type anything into this stored snapshot? Autosave writes a
     snapshot for every date the form is opened on, so a day someone merely
     browsed to leaves a blank one behind — listing those buries the real
     drafts and makes each of them look like an unsent report. A standing
     default (data-default) or an auto-computed cell is put there by the
     page, not by a person. */
  function _hasEntry(data) {
    return Object.keys(data || {}).some(k => {
      const v = data[k];
      if (k === 'date' || k === 'prepared_by' || (k.charAt(0) === '_' && k.indexOf('_a_') !== 0)) return false;
      if (v === '' || v === null || v === undefined) return false;
      const el = document.querySelector('[data-field="' + CSS.escape(k) + '"]');
      if (el && el.hasAttribute('data-auto-computed')) return false;
      if (el && (el.getAttribute('data-default') === String(v) || el.defaultValue === String(v))) return false;   // a value the markup shipped with is not something a person typed
      return true;
    });
  }

  /* serverRows: undefined while the server has not answered, null if it
     could not be reached, else the /history rows (newest first). */
  function _historyEntries(formId, serverRows) {
    const byDate = new Map();

    _allSaved(formId).forEach(key => {
      let snap = null;
      try { snap = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
      const meta = (snap && snap._m) || {};
      const date = meta.date || key.slice(`${NS}-${formId}-`.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      byDate.set(date, {
        date, status: _normaliseStatus(meta.status), savedAt: meta.savedAt || null,
        local: true, server: false, savedBy: null, deviceOnly: false,
        hasEntry: _hasEntry(snap && snap.data),
      });
    });

    const answered = Array.isArray(serverRows);
    (answered ? serverRows : []).forEach(r => {
      const e = byDate.get(r.record_date) || { date: r.record_date, local: false, deviceOnly: false };
      byDate.set(r.record_date, Object.assign(e, {
        status: _normaliseStatus(r.status),
        savedAt: r.updated_at || r.submitted_at || e.savedAt || null,
        server: true, hasEntry: true, savedBy: r.saved_by_name || null,
      }));
    });

    /* "Not on the server" is only a safe claim about a day the server's list
       actually covers: a full list (limit reached) says nothing about days
       older than its last row. */
    if (answered) {
      const full   = serverRows.length >= _HISTORY_LIMIT;
      const oldest = serverRows.length ? serverRows[serverRows.length - 1].record_date : null;
      byDate.forEach(e => {
        e.deviceOnly = e.local && !e.server && (!full || (oldest !== null && e.date >= oldest));
      });
    }

    return [...byDate.values()]
      .filter(e => e.server || e.hasEntry)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  /* Opening a day from the panel is exactly picking it in the date field:
     the change handler in initFormPersist unlocks the form, loads the record
     (server first), applies its status and announces it — and every other
     listener the page hangs on that field (roll-ups, KPI strips) reacts too.
     The panel used to call _read() directly, which skipped all of that and,
     for a record whose data carries no `date` key (an import, an Odoo-made
     draft), left the form showing one day's date over another day's figures. */
  function _openDate(date) {
    const el = document.querySelector('input[type="date"]');
    if (!el) return;
    el.value = date;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const _BADGE_STYLE = {
    draft:            'background:var(--st-warn-bg);color:var(--st-warn)',
    pending_approval: 'background:var(--st-warn-bg);color:var(--st-warn)',
    approved:         'background:var(--st-good-bg);color:var(--st-good)',
    rejected:         'background:var(--st-bad-bg);color:var(--st-bad)',
  };

  function _showHistory(formId, anchor) {
    document.getElementById('_nyh')?.remove();

    const rect  = anchor.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.id = '_nyh';
    Object.assign(panel.style, {
      position: 'fixed',
      top:  Math.min(rect.bottom + 6, window.innerHeight - 360) + 'px',
      left: Math.max(Math.min(rect.left, window.innerWidth - 348), 8) + 'px',
      zIndex: '9998', background: 'white',
      border: '1.5px solid #DDE3EC', borderRadius: '10px',
      boxShadow: '0 8px 36px rgba(0,0,0,.16)',
      minWidth: '280px', maxWidth: '340px',
      fontFamily: 'Inter,sans-serif', overflow: 'hidden'
    });

    // Header
    const hdr = document.createElement('div');
    hdr.style.cssText = 'background:#173158;color:white;padding:10px 14px;font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center';
    const hdrTitle = document.createElement('span');
    hdrTitle.textContent = 'Saved Reports';
    const hdrCount = document.createElement('span');
    hdrCount.style.cssText = 'font-size:12px;opacity:.75';
    hdr.appendChild(hdrTitle);
    hdr.appendChild(hdrCount);
    panel.appendChild(hdr);

    const list = document.createElement('div');
    list.style.cssText = 'max-height:280px;overflow-y:auto';
    panel.appendChild(list);

    const note = document.createElement('div');
    note.style.cssText = 'padding:8px 14px;font-size:12px;line-height:1.5;color:var(--st-neutral);background:#F7F8FA;border-top:1px solid #EEF2F7';
    panel.appendChild(note);

    // Footer close
    const foot = document.createElement('div');
    foot.style.cssText = 'padding:9px 14px;text-align:center;font-size:12px;color:var(--text-muted);cursor:pointer;background:#F7F8FA;border-top:1px solid #EEF2F7';
    foot.textContent = '✕  Close';
    foot.onclick = () => panel.remove();
    panel.appendChild(foot);

    let serverRows;   // undefined = asking, null = unreachable, array = answer

    function paint() {
      const entries = _historyEntries(formId, serverRows);
      hdrCount.textContent = entries.length + ' saved';
      list.textContent = '';

      if (!entries.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px 14px;font-size:12px;color:var(--text-muted);text-align:center;line-height:1.6';
        empty.textContent = serverRows === undefined
          ? 'Checking for saved reports…'
          : 'No saved reports yet. Fill the form and click Save Draft.';
        list.appendChild(empty);
      }

      entries.forEach(e => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 14px;cursor:pointer;border-bottom:1px solid #F0F4F8;display:flex;justify-content:space-between;align-items:center;gap:10px;transition:background .1s';
        row.onmouseenter = () => (row.style.background = '#EFF6FF');
        row.onmouseleave = () => (row.style.background = '');

        const left = document.createElement('div');
        const dateEl = document.createElement('div');
        dateEl.style.cssText = 'font-weight:600;color:#173158;font-size:12px';
        dateEl.textContent = e.date;
        left.appendChild(dateEl);
        const sub = e.deviceOnly ? 'This device only — not on the server'
                  : (e.savedBy ? 'by ' + e.savedBy : '');
        if (sub) {
          const subEl = document.createElement('div');
          subEl.style.cssText = 'font-size:12px;margin-top:2px;color:' + (e.deviceOnly ? 'var(--st-warn)' : 'var(--text-muted)') + (e.deviceOnly ? ';font-weight:700' : '');
          subEl.textContent = sub;
          left.appendChild(subEl);
        }

        const right = document.createElement('div');
        right.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0';
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:12px;font-weight:700;padding:2px 7px;border-radius:6px;' + (_BADGE_STYLE[e.status] || _BADGE_STYLE.draft);
        badge.textContent = STATUS_META[e.status].pill;
        right.appendChild(badge);
        if (e.savedAt) {
          const when = document.createElement('span');
          when.style.cssText = 'color:var(--text-muted);font-size:12px';
          try {
            when.textContent = new Date(e.savedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
          } catch (err) { when.textContent = ''; }
          right.appendChild(when);
        }

        row.appendChild(left);
        row.appendChild(right);
        row.onclick = () => { panel.remove(); _openDate(e.date); };
        list.appendChild(row);
      });

      if (serverRows === undefined) note.textContent = 'Checking the server…';
      else if (serverRows === null) note.textContent = 'The server could not be reached — showing only what this browser has.';
      else if (entries.some(e => e.deviceOnly)) note.textContent = 'Open a "this device only" day and press Save Draft to send it to the server.';
      else note.textContent = 'Showing reports saved on the server and on this device.';
    }

    paint();
    document.body.appendChild(panel);

    if (global.NyatiAPI && typeof global.NyatiAPI.getFormHistory === 'function') {
      global.NyatiAPI.getFormHistory(formId, _HISTORY_LIMIT)
        .then(rows => { serverRows = rows; })
        .catch(() => { serverRows = null; })
        .then(() => { if (panel.isConnected) paint(); });
    } else {
      serverRows = null;
      paint();
    }

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

      // Cosmetic-only display rounding, opt-in per page via
      // window.NYATI_LOCKED_DISPLAY_FMT(field, value) -> string|null. The
      // exact value is stashed in data-raw-value and restored verbatim by
      // _unlockForm(), so a later edit-and-resubmit still sends the real
      // number — this never touches what actually gets saved.
      if (typeof global.NYATI_LOCKED_DISPLAY_FMT === 'function' && inp.dataset.field) {
        const field = inp.dataset.field;
        const raw = inp.value;
        if (raw !== '' && !isNaN(+raw)) {
          const display = global.NYATI_LOCKED_DISPLAY_FMT(field, +raw);
          if (display !== null && display !== undefined && display !== raw) {
            inp.dataset.rawValue = raw;
            inp.value = display;
          }
        }
      }
    });
    document.querySelectorAll('.btn-save, .btn-sub').forEach(b => {
      b.disabled = true;
      b.style.opacity = '.45';
      b.style.cursor  = 'not-allowed';
    });

    /* The banner is _showStatusBanner()'s job — it used to be hardcoded
       green "Report Submitted & Locked" here, which is the wrong message
       for a report that is merely awaiting sign-off, and flatly wrong for
       one that was rejected. */
  }

  /* ── Unlock form — reverses _lockForm(), used when the date is
     changed away from a previously-submitted date. ─────────────────── */
  function _unlockForm() {
    document.querySelectorAll('.ci, .tb-ctl').forEach(inp => {
      // data-auto-computed marks an input that is ALWAYS readonly — its
      // value is derived from other fields on the page (e.g. power-plant-
      // report.html's Heat Rate cells), not something the submit-lock made
      // readonly. Unlocking the form must not turn these into free-typed
      // fields.
      if (inp.hasAttribute('data-auto-computed')) return;
      inp.removeAttribute('readonly');
      if (inp.dataset.rawValue !== undefined) {
        inp.value = inp.dataset.rawValue;
        delete inp.dataset.rawValue;
      }
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
    const st   = _normaliseStatus(status);
    const meta = STATUS_META[st];
    pill.textContent = meta.pill;
    /* .is-submitted is the page's existing green style; keep it for the two
       states that mean "this has been sent", and mark the other two so a
       page can style them without knowing this file's vocabulary. */
    pill.classList.toggle('is-submitted', st === 'approved' || st === 'pending_approval');
    pill.classList.toggle('is-pending',  st === 'pending_approval');
    pill.classList.toggle('is-rejected', st === 'rejected');

    /* The printed sign-off strip states the status too, at the bottom of
       the page. It was the literal word DRAFT in the markup, so an
       approved report printed "Status: DRAFT" underneath a toolbar
       reading APPROVED — and the printed copy is the one that gets
       filed. Anything carrying data-report-status follows the pill. */
    document.querySelectorAll('[data-report-status]').forEach(el => { el.textContent = meta.pill; });
  }

  /* ── Status banner ───────────────────────────────────────────────
     One banner driven by STATUS_META, replacing the hardcoded green
     "Report Submitted & Locked" strip _lockForm() used to paint whatever
     the server had actually decided. */
  function _showStatusBanner(status, reason) {
    document.getElementById('_nyb')?.remove();
    const meta = STATUS_META[_normaliseStatus(status)];
    if (!meta || !meta.banner) return;

    const banner = document.createElement('div');
    banner.id = '_nyb';
    const msg = document.createElement('span');
    /* textContent, not innerHTML: `reason` is free text typed by an HOD. */
    msg.textContent = meta.banner.text + (reason ? '  Reason: ' + reason : '');
    banner.appendChild(msg);

    const close = document.createElement('button');
    close.type = 'button';
    close.title = 'Dismiss';
    close.textContent = '×';
    close.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);' +
      'background:rgba(255,255,255,.25);border:none;color:white;width:22px;height:22px;' +
      'border-radius:50%;cursor:pointer;font-size:14px;line-height:1;display:flex;' +
      'align-items:center;justify-content:center;font-family:inherit';
    close.addEventListener('click', () => banner.remove());
    banner.appendChild(close);

    Object.assign(banner.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9997',
      background: meta.banner.bg, color: 'white', padding: '9px 48px 9px 16px',
      textAlign: 'center', fontFamily: 'Inter,sans-serif',
      fontSize: '12px', fontWeight: '700', letterSpacing: '.3px',
    });
    document.body.prepend(banner);
  }

  /* Apply every visible consequence of a status in one call, so no caller
     can set the pill and forget the lock (or vice versa). */
  function _applyStatus(status, reason) {
    const st = _normaliseStatus(status);
    S.status   = st;
    S.editable = !STATUS_META[st].locked;
    if (!S.editable) {
      /* A report awaiting sign-off, or approved, belongs to the approver:
         nothing pending may be written to it from here. */
      clearTimeout(S.localTimer);
      clearTimeout(S.serverTimer);
      S.dirty = false;
    }
    _updateStatusPill(st);
    /* Lock/unlock FIRST: _unlockForm() clears the banner element, so
       painting the banner before it would wipe the rejection notice — the
       one state where the form is both unlocked and needs a message. */
    if (STATUS_META[st].locked) _lockForm(); else _unlockForm();
    _showStatusBanner(st, reason);
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

  /* ══ Unfinished reports ════════════════════════════════════════════
     "You have a draft for 19 Sept." Nothing used to say so: a draft was only
     found by going looking for it, on the right device, in Load Previous.
     This is the caller's own list (drafts + rejected reports on the forms
     their role may submit), kept in memory and adjusted locally after every
     save so the banner and the sidebar dots stay right without re-asking. */
  const U = { rows: null, at: 0 };

  async function _fetchUnfinished(force) {
    if (!global.NyatiAPI || typeof global.NyatiAPI.getUnfinished !== 'function') return U.rows;
    if (!force && U.rows && Date.now() - U.at < 60000) return U.rows;
    try { U.rows = await global.NyatiAPI.getUnfinished(14); U.at = Date.now(); }
    catch (e) { /* offline — keep whatever we already had */ }
    return U.rows;
  }

  function _niceDate(d) {
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? d : dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function _ensurePersistCSS() {
    if (document.getElementById('_ny-persist-css')) return;
    const s = document.createElement('style');
    s.id = '_ny-persist-css';
    s.textContent =
      '.ny-unfin{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin:10px 16px 0;padding:8px 48px 8px 14px;' +
        'border:1px solid var(--st-warn-bd);border-left:3px solid var(--st-warn);border-radius:8px;' +
        'background:var(--st-warn-bg);color:var(--st-warn);font:600 12px/1.5 Inter,sans-serif}' +
      '.ny-unfin.is-rejected{border-color:var(--st-bad-bd);border-left-color:var(--st-bad);background:var(--st-bad-bg);color:var(--st-bad)}' +
      '.ny-unfin button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;' +
        'padding:4px 10px;cursor:pointer;min-height:32px}' +
      '.ny-unfin button:hover{background:rgba(0,0,0,.06)}' +
      '.ny-unfin .ny-x{position:absolute;top:4px;right:4px;margin:0;border:none;font-size:16px;line-height:1;padding:4px 10px;min-width:32px}' +
      '@media (pointer:coarse){.ny-unfin button{min-height:44px}.ny-unfin .ny-x{min-width:44px}}';
    document.head.appendChild(s);
  }

  function _paintUnfinished(formId) {
    document.getElementById('_ny-unfin')?.remove();
    if (!U.rows) return;
    try { if (sessionStorage.getItem('nyati-unfin-off-' + formId)) return; } catch (e) { /* storage blocked — show it */ }

    const cur  = S.loadedDate || _dateVal(document.body);
    const mine = U.rows.filter(r => r.form_type === formId && r.record_date !== cur);
    if (!mine.length) return;

    const bar = document.createElement('div');
    bar.id = '_ny-unfin';
    bar.className = 'ny-unfin' + (mine.some(r => r.status === 'rejected') ? ' is-rejected' : '');
    bar.setAttribute('role', 'status');

    const lead = document.createElement('span');
    lead.textContent = mine.length === 1 ? 'You have an unfinished report:' : 'You have ' + mine.length + ' unfinished reports:';
    bar.appendChild(lead);

    mine.slice(0, 3).forEach(r => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = _niceDate(r.record_date) + ' · ' + (r.status === 'rejected' ? 'rejected — needs correction' : 'draft') + ' — Open';
      if (r.rejection_reason) b.title = 'Reason: ' + r.rejection_reason;   // textContent-safe: a title attribute
      b.addEventListener('click', () => _openDate(r.record_date));
      bar.appendChild(b);
    });
    if (mine.length > 3) {
      const more = document.createElement('span');
      more.textContent = '+' + (mine.length - 3) + ' more in Load Previous';
      bar.appendChild(more);
    }

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ny-x';
    x.setAttribute('aria-label', 'Dismiss for this session');
    x.title = 'Dismiss for this session';
    x.textContent = '×';
    x.addEventListener('click', () => {
      try { sessionStorage.setItem('nyati-unfin-off-' + formId, '1'); } catch (e) { /* not remembered — fine */ }
      bar.remove();
    });
    bar.appendChild(x);

    const anchor = document.querySelector('.toolbar');
    if (anchor) anchor.insertAdjacentElement('afterend', bar);
    else document.body.prepend(bar);
  }

  /* A save just changed what the server holds for one day: reflect it
     without another round trip, and tell the sidebar. `status` null means it
     is no longer unfinished (it was submitted). */
  function _unfinishedTouch(formId, date, status) {
    if (U.rows) {
      U.rows = U.rows.filter(r => !(r.form_type === formId && r.record_date === date));
      if (status === 'draft' || status === 'rejected') {
        U.rows.push({ form_type: formId, record_date: date, status });
        U.rows.sort((a, b) => (a.record_date < b.record_date ? 1 : a.record_date > b.record_date ? -1 : 0));
      }
    }
    document.dispatchEvent(new CustomEvent('nyati:draft-state', { detail: { formId, date, status } }));
    _paintUnfinished(formId);
  }

  /* ══ Autosave ══════════════════════════════════════════════════════
     Save Draft used to be the ONLY thing that put a half-typed report on the
     server; the 60-second timer wrote localStorage alone. Anyone who forgot
     the button, switched days, or closed the tab left nothing behind for
     another device — or for themselves, if the browser's storage was
     cleared. Now:

       • every real edit (not a script filling a cell) is kept on this device
         a second after the last keystroke, and marks the form "unsaved";
       • twenty seconds after typing stops — never later than a minute after
         the first unsaved edit — it is sent to the server as an autosave (the
         server refuses to touch a submitted/approved report, keeps a
         rejected report rejected, and writes no audit row: see routes/reports.js);
       • switching to another day, or hiding/closing the tab, sends it first;
       • if the server cannot be reached the chip says "Saved on this device
         only", it retries by itself, and the next visit puts the typed work
         back (see _load). */
  const _AUTOSAVE_IDLE_MS = 20000;
  const _AUTOSAVE_MAX_MS  = 60000;
  const _LOCAL_IDLE_MS    = 1000;
  // Tunable so a test does not have to wait twenty real seconds.
  const _idleMs = () => (typeof global.NYATI_AUTOSAVE_MS === 'number' ? global.NYATI_AUTOSAVE_MS : _AUTOSAVE_IDLE_MS);
  // A failed autosave is retried after one idle period, then doubling to a two-minute ceiling.
  const _retryBase = () => Math.max(1000, _idleMs());

  function _markDirty() {
    if (!S.editable || !S.formId) return;
    S.editVersion++;
    if (!S.dirty) { S.dirty = true; S.dirtySince = Date.now(); }
    _setChip(S.stopped || S.failed ? 'device' : 'dirty');
    clearTimeout(S.localTimer);
    S.localTimer = setTimeout(_writeLocalNow, _LOCAL_IDLE_MS);
    _scheduleServer();
  }

  function _writeLocalNow() {
    if (!S.editable || !S.loadedDate || S.loadedDate !== _dateVal(document.body)) return;
    _write(S.formId, 'draft', { date: S.loadedDate, unsynced: true });
  }

  function _scheduleServer(delay) {
    clearTimeout(S.serverTimer);
    if (S.stopped || !S.dirty) return;
    const wait = delay != null ? delay
               : Math.max(0, Math.min(_idleMs(), S.dirtySince + _AUTOSAVE_MAX_MS - Date.now()));
    S.serverTimer = setTimeout(_autosaveNow, wait);
  }

  async function _autosaveNow() {
    if (!S.dirty || S.stopped || !S.editable || !S.formId) return;
    if (S.inflight) { _scheduleServer(2000); return; }
    const date = S.loadedDate;
    // A day switch is still loading: the screen and the date field disagree.
    if (!date || date !== _dateVal(document.body)) return;

    const { payload } = _write(S.formId, 'draft', { date, unsynced: true });
    // Nothing on the server yet and nothing typed worth keeping: do not
    // create an empty draft just because a field was touched and cleared.
    if (!S.serverHasRow && !_hasEntry(payload.data)) { S.dirty = false; _setChip('none'); return; }

    S.inflight = true;
    const v = S.editVersion;
    _setChip('saving');
    const res = await _syncToServer(S.formId, date, payload.data, 'draft', { autosave: true });
    S.inflight = false;

    if (res.ok) {
      S.serverHasRow = true; S.failed = false; S.retryMs = _retryBase();
      if (S.editVersion === v) _markSynced(S.formId, date);
      _unfinishedTouch(S.formId, date, res.status);
      if (S.editVersion === v && S.loadedDate === date) { S.dirty = false; _setChip('server'); }
      else { S.dirtySince = Date.now(); _setChip('dirty'); _scheduleServer(); }   // more typed while it was in flight: a fresh window, not a burst of saves
    } else if (res.locked) {
      S.stopped = true;
      _setChip('device');
      _toast('This report was submitted or approved from another window, so it is no longer being autosaved. ' +
             'Reload the page to see the current version — what you just typed is kept on this device.', 'warn', 12000);
    } else if (res.retry) {
      S.failed = true;
      _setChip('device');
      _scheduleServer(S.retryMs);
      S.retryMs = Math.min(S.retryMs * 2, 120000);
    } else {
      S.stopped = true;
      _setChip('device');
      const code = res.error && res.error.status ? ' (HTTP ' + res.error.status + ')' : '';
      _toast('The server would not accept this draft' + code + ', so it is only saved on this device. Press Save Draft to see why, or tell IT.', 'err', 12000);
    }
  }

  /* Leaving a day (the date field changed) while it holds unsaved work: keep
     it as a draft under ITS date first. The change event fires after the
     field already shows the new day but before the form is reloaded, so the
     old figures are still on screen to collect. */
  function _handOff(prevDate) {
    const hadRow = S.serverHasRow;
    const { payload } = _write(S.formId, 'draft', { date: prevDate, unsynced: true });
    S.dirty = false;
    clearTimeout(S.localTimer);
    clearTimeout(S.serverTimer);
    S.handedOff = prevDate;   // reported together with the next day loading (see loadDay)
    if (!hadRow && !_hasEntry(payload.data)) return;
    const formId = S.formId;
    _syncToServer(formId, prevDate, payload.data, 'draft', { autosave: true }).then(res => {
      if (res.ok) { _markSynced(formId, prevDate); _unfinishedTouch(formId, prevDate, res.status); }
    });
  }

  /* The tab is being hidden or closed. keepalive lets the request outlive the
     page; if it does not get through, the device copy is still there. */
  function _flushOnHide() {
    if (!S.dirty || !S.editable || S.stopped || !S.loadedDate || !global.NyatiAPI) return;
    if (S.loadedDate !== _dateVal(document.body) || S.flushedVersion === S.editVersion) return;
    const { payload } = _write(S.formId, 'draft', { date: S.loadedDate, unsynced: true });
    if (!S.serverHasRow && !_hasEntry(payload.data)) return;
    S.flushedVersion = S.editVersion;
    const data = Object.assign({}, payload.data, { _status: 'draft' });
    global.NyatiAPI.submitForm(S.formId, S.loadedDate, 'day', data,
      { status: 'draft', autosave: true, keepalive: true }).catch(() => { /* the device copy remains */ });
  }

  /* Rows a page adds by script get names too (see _nameAnonymous). Only
     additions that actually contain a form control are looked at, so the
     constant text updates of the KPI strips cost nothing. */
  function _watchAddedInputs() {
    if (typeof MutationObserver === 'undefined') return;
    let queued = false;
    new MutationObserver(muts => {
      if (queued) return;
      const relevant = muts.some(m => [...m.addedNodes].some(n =>
        n.nodeType === 1 && (n.matches(_SEL) || n.querySelector(_SEL))));
      if (!relevant) return;
      queued = true;
      setTimeout(() => { queued = false; _nameAnonymous(document.body); }, 0);
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ══ Public entry point ════════════════════════════════════════════ */
  global.initFormPersist = function (formId) {
    global._nyatiFormId = formId;
    S.formId = formId;
    const body      = document.body;
    const dateInput = body.querySelector('input[type="date"]');

    _ensurePersistCSS();
    _nameAnonymous(body);      // first thing — before mobile-entry.js starts moving inputs into cards
    _watchAddedInputs();

    /* Default to today, not whatever demo date is baked into the HTML —
       a daily report should open on the current day, every day. */
    if (dateInput && !dateInput.value) {
      dateInput.value = _todayStr();
    }

    /* ── What counts as the person editing ───────────────────────────
       Only trusted events (isTrusted): report-loader and kpi-live fill and
       recompute cells by script and dispatch their own input events, and
       those must not turn "I opened the page" into "I have unsaved work" —
       or every visit would create a draft. Only controls inside the report
       or its toolbar count, not a search box in the header. */
    const onEdit = e => {
      if (!e.isTrusted) return;
      const el = e.target;
      if (!el || !el.matches || !el.matches(_SEL) || !_persistable(el) || el.readOnly) return;
      if (!el.closest('main, .toolbar')) return;
      _markDirty();
    };
    document.addEventListener('input',  onEdit, true);
    document.addEventListener('change', onEdit, true);

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') _flushOnHide(); });
    window.addEventListener('pagehide', _flushOnHide);
    window.addEventListener('beforeunload', e => {
      // Only when the work is NOT known to be safe: the server has not got it
      // and cannot be reached right now. A normal close is saved by the flush above.
      if (S.dirty && S.editable && (S.failed || S.stopped || !navigator.onLine)) { e.preventDefault(); e.returnValue = ''; }
    });

    /* Programmatic edits that ARE the user's work (the Excel import) say so. */
    global.NyatiPersist = {
      markDirty: _markDirty,
      saveNow:   _autosaveNow,
      state:     () => Object.assign({}, S),
      unfinished: () => (U.rows || []).slice(),
    };

    /* Load a day into the form: server first, this device as fallback, and a
       clean form if neither has it. Each load takes a ticket; if another one
       started while this one waited on the network, this one is dropped —
       otherwise a slow first load could land AFTER the user had already moved
       to another day and wipe it. */
    async function loadDay(date, initial) {
      const ticket = ++S.loadToken;
      const res = await _load(formId, date);
      if (ticket !== S.loadToken) return;

      const meta = _applyLoaded(formId, date, res);
      S.loadedDate   = date;
      S.serverHasRow = res.serverRow;
      S.dirty = false; S.stopped = false; S.failed = false; S.retryMs = _retryBase();
      clearTimeout(S.localTimer); clearTimeout(S.serverTimer);

      const kept = S.handedOff ? ' Your unsaved changes on ' + S.handedOff + ' were kept as a draft.' : '';
      S.handedOff = null;
      if (meta) {
        if (!initial) {
          _toast(`Loaded ${STATUS_META[_normaliseStatus(meta.status)].pill.toLowerCase()} — ${meta.date || date}${kept ? "." + kept : ""}`, 'ok', kept ? 6000 : 0);
        }
        _applyStatus(meta.status, meta.rejectionReason);
      } else {
        _clearForm(body);
        _applyStatus('draft');
        if (kept) _toast(kept.trim(), 'ok', 6000);
      }

      /* Work that only this device has — typed and never confirmed, or a
         draft whose send failed — goes up now instead of waiting for a click. */
      if (S.editable && (res.source === 'recovered'
          || (res.source === 'local' && res.reached && _hasEntry(res.payload && res.payload.data)))) {
        _markDirty();
        if (res.source === 'recovered') {
          _setChip('recovered');
          _toast('Recovered changes you typed earlier that never reached the server — sending them now.', 'warn', 8000);
        }
      } else if (res.source === 'local' && !res.reached) {
        _setChip('device');
        _toast('The server could not be reached — showing what this device has.', 'warn', 6000);
      } else if (res.source === 'server') {
        _setChip(S.editable ? 'server' : 'submitted', meta && meta.savedAt);
      } else {
        _setChip('none');
      }

      // Which other days of this form are still unfinished?
      _fetchUnfinished(initial).then(() => { if (ticket === S.loadToken) _paintUnfinished(formId); });
    }

    /* Save Draft — saves locally immediately, then sends it to the server.
       The toast waits for the server's answer: it used to announce "Draft
       saved" the instant the browser wrote localStorage and only then, if
       the send failed, replace it with a three-second warning — so a draft
       that never left this device was reported as saved. */
    body.querySelectorAll('.btn-save').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.preventDefault();
        const date = _dateVal(body);
        if (S.loadedDate && S.loadedDate !== date) {
          _toast('Still loading this day — try again in a moment.', 'warn');
          return;
        }
        clearTimeout(S.localTimer);
        clearTimeout(S.serverTimer);
        const v = S.editVersion;
        const { payload } = _write(formId, 'draft', { date, unsynced: true });
        _toast(`Saving draft — ${date}…`, 'ok');
        _setChip('saving');
        _applyStatus('draft');
        document.dispatchEvent(new CustomEvent('nyati:saved', { detail: { formId, date } }));

        const sync = await _syncToServer(formId, date, payload.data, 'draft');
        if (sync.ok) {
          S.serverHasRow = true; S.failed = false; S.stopped = false;
          if (S.editVersion === v) { _markSynced(formId, date); S.dirty = false; _setChip('server'); }
          else { S.dirtySince = Date.now(); _setChip('dirty'); _scheduleServer(); }
          _unfinishedTouch(formId, date, sync.status || 'draft');
          _toast(`Draft saved — ${date}`, 'ok');
        } else if (sync.queued) {
          S.failed = true; S.dirty = true; _setChip('device');
          _toast(`Draft kept on this device only — the server could not be reached. It sends by itself once the connection is back.`, 'warn', 8000);
        } else {
          S.dirty = true; _setChip('device');
          const code = sync.error && sync.error.status ? ` (HTTP ${sync.error.status})` : '';
          _toast(`Draft NOT saved to the server${code}. It is kept on this device only — tell IT if this repeats.`, 'err', 10000);
        }
      });
    });

    /* Load Previous — bound by its own data-persist="history" hook, NOT by
       .btn-out. That is only the outline-button style, and binding to it
       swallowed every other outline button on the page: the bottom "Save
       Draft" (which opened this panel instead of saving anything), the
       "View report" links (which never navigated) and "Add pile row". */
    body.querySelectorAll('[data-persist="history"]').forEach(btn => {
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
        if (S.loadedDate && S.loadedDate !== date) {
          _toast('Still loading this day — try again in a moment.', 'warn');
          return;
        }

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

        clearTimeout(S.localTimer);
        clearTimeout(S.serverTimer);

        // Save as submitted then download
        const { payload } = _write(formId, 'submitted', { unsynced: true });
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = `nyati-${formId}-${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);

        _applyStatus('pending_approval');   // provisional until the server answers
        _setChip('submitted');
        document.dispatchEvent(new CustomEvent('nyati:submitted', { detail: { formId, date } }));

        const sync = await _syncToServer(formId, date, payload.data, 'submitted');
        if (sync.ok) {
          /* Officers and Seniors land in 'pending_approval'; an HOD's own
             entry self-certifies as 'approved'. Show whichever it actually
             is rather than a blanket "Submitted", so nobody assumes their
             report is signed off when it is still sitting in a queue. */
          const st = _normaliseStatus(sync.status || 'approved');
          S.serverHasRow = true;
          _markSynced(formId, date);
          _applyStatus(st);
          _setChip('submitted');
          _unfinishedTouch(formId, date, null);
          _toast(st === 'pending_approval'
            ? `Submitted for ${date} — awaiting your HOD's sign-off`
            : `Report submitted — nyati-${formId}-${date}.json downloaded`, 'ok');
        } else if (sync.queued) {
          _setChip('device');
          _toast(`Submitted locally — server offline, queued for auto-sync`, 'warn');
        } else {
          _toast(`Submitted & downloaded locally — the server REJECTED it. Contact IT.`, 'err');
        }
      });
    });

    /* On date change → load saved data for that date, or start a clean
       draft if none exists. Always unlock first: a date switch away from
       a submitted day must never leave the new day's fields frozen. Unsaved
       work on the day being left is kept as a draft first. */
    if (dateInput) {
      dateInput.addEventListener('change', async () => {
        const next = dateInput.value;
        if (!next) return;
        if (S.dirty && S.editable && S.loadedDate && S.loadedDate !== next) _handOff(S.loadedDate);
        _unlockForm();
        await loadDay(next, false);
      });
    }

    /* On page load → silently restore today's data if saved, and reflect
       the real status on the toolbar pill (was previously stuck on the
       static "DRAFT" text baked into the HTML).

       When there is NOTHING saved for today, clear — exactly as the date
       -change handler above already does. This path used to apply the
       status and stop there, which meant a form opened on a day nobody had
       filed yet still showed whatever figures were typed into its markup,
       under a "DRAFT" pill that made them look like somebody's work in
       progress. On the Dispatch & SO report that was a full day of April
       2026 numbers — 346.5 MT dispatched, 7,530 bags, a burst rate, a
       stoppage remark — and initKpiLive() then computed the KPI strip from
       them, so the page reported 376.5 MT as the day's dispatch. Worse
       than a blank page, because a blank page cannot be believed.

       _restore() only overwrites the fields a saved payload actually
       carries, so this matters for partial reports too: without the clear,
       a report with three figures entered kept mockup values in every
       other cell and the totals added the two together. ───────────────── */
    if (dateInput && dateInput.value) loadDay(dateInput.value, true);
  };

}(window));