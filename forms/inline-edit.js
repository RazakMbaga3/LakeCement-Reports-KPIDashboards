/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Inline Edit Engine  v1.0
   Allows each department to fill their section directly on the
   daily report page — no separate form pages required.
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const NS = 'nyati';

  function _getDate() {
    const d = document.querySelector('.toolbar input[type="date"], input[type="date"]');
    if (d && d.value) return d.value;
    /* Local calendar date, never toISOString(): EAT is UTC+3, so between
       local midnight and 03:00 the UTC date is still yesterday. */
    const n = new Date(), p2 = v => (v < 10 ? '0' : '') + v;
    return n.getFullYear() + '-' + p2(n.getMonth() + 1) + '-' + p2(n.getDate());
  }

  function _toast(msg, type) {
    type = type || 'ok';
    const colors = { ok: '#239557', warn: '#D97706', err: '#DC2626' };
    const icons  = { ok: '✓', warn: '⚠', err: '✕' };
    const old = document.getElementById('_ie-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = '_ie-toast';
    el.innerHTML = '<span style="font-size:15px">' + icons[type] + '</span><span>' + msg + '</span>';
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '9999',
      background: colors[type], color: 'white',
      padding: '11px 20px', borderRadius: '9px',
      fontFamily: 'Inter,sans-serif', fontSize: '13px', fontWeight: '600',
      boxShadow: '0 4px 24px rgba(0,0,0,.22)',
      display: 'flex', alignItems: 'center', gap: '10px',
    });
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  global.InlineEdit = {

    open: async function (sectionId, formId) {
      var viewEl = document.getElementById(sectionId + '-view');
      var editEl = document.getElementById(sectionId + '-edit');
      if (viewEl) viewEl.style.display = 'none';
      if (editEl) {
        editEl.style.display = '';
        await this._load(editEl, formId);
        editEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    },

    close: function (sectionId) {
      var viewEl = document.getElementById(sectionId + '-view');
      var editEl = document.getElementById(sectionId + '-edit');
      if (viewEl) viewEl.style.display = '';
      if (editEl) editEl.style.display = 'none';
    },

    /* Server first (source of truth), localStorage fallback (offline). */
    _load: async function (panelEl, formId) {
      var date = _getDate();
      var data = null;

      if (global.NyatiAPI) {
        try {
          var record = await global.NyatiAPI.getForm(formId, date);
          if (record && record.data) data = record.data;
        } catch (e) { /* fall through to localStorage */ }
      }

      if (!data) {
        var raw = localStorage.getItem(NS + '-' + formId + '-' + date);
        if (!raw) return;
        try { data = JSON.parse(raw).data || {}; } catch (e) { return; }
      }

      panelEl.querySelectorAll('[data-inline]').forEach(function (el) {
        var f = el.getAttribute('data-inline');
        if (data[f] !== undefined) el.value = data[f];
      });
    },

    /* Local write happens immediately (unchanged fallback/cache behavior);
       server sync is best-effort on top of it. */
    save: async function (sectionId, formId) {
      var editEl = document.getElementById(sectionId + '-edit');
      if (!editEl) return;

      var date = _getDate();
      var data = {};
      editEl.querySelectorAll('[data-inline]').forEach(function (el) {
        data[el.getAttribute('data-inline')] = el.value;
      });

      var key = NS + '-' + formId + '-' + date;
      var existing = {};
      try { existing = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}

      var merged = Object.assign({}, existing.data || {}, data);
      var payload = {
        _m: { formId: formId, date: date, savedAt: new Date().toISOString(), status: 'draft' },
        inputs: existing.inputs || [],
        data: merged,
      };
      localStorage.setItem(key, JSON.stringify(payload));

      document.dispatchEvent(new CustomEvent('nyati:inline-saved', { detail: { formId: formId } }));
      if (typeof global.refreshReportLoader === 'function') global.refreshReportLoader();

      /* Send only the fields this panel changed and let the server merge them
         into the stored record. It used to send `merged` — the changed
         fields layered over whatever THIS browser had in localStorage — into
         an endpoint that then replaced the whole row. On a machine with no
         cached copy (a fresh browser, a different device, cleared storage)
         `merged` was just the handful of edited fields, so saving one
         section wiped every other department's.

         Filling in a section IS that department's submission of it — this
         file exists so a department can report without opening a separate
         form page — so it goes in as 'submitted', which re-applies the
         approval rules: an Officer's amendment needs fresh sign-off, an
         HOD's self-certifies. */
      var wire = Object.assign({}, data, { _status: 'submitted' });
      var synced = true, queued = false;
      if (global.NyatiAPI) {
        try {
          await global.NyatiAPI.submitForm(formId, date, 'day', wire, { status: 'submitted' });
        } catch (e) {
          synced = false;
          // Retryable outage (offline, 401, 5xx) → hand to the offline queue
          if (global.NyatiQueue && (!e.status || e.status === 401 || e.status >= 500)) {
            global.NyatiQueue.enqueue(formId, date, 'day', wire);
            queued = true;
          }
        }
      }

      _toast(synced
        ? 'Saved — ' + formId.replace(/-/g, ' ') + ' data updated'
        : (queued
          ? 'Saved locally — offline, queued for auto-sync'
          : 'Saved locally — the server rejected ' + formId.replace(/-/g, ' ')), synced ? 'ok' : 'warn');
      this.close(sectionId);
    },
  };

}(window));
