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
    return d ? d.value : new Date().toISOString().slice(0, 10);
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

      var synced = true;
      if (global.NyatiAPI) {
        try {
          await global.NyatiAPI.submitForm(formId, date, 'day', Object.assign({}, merged, { _status: 'draft' }));
        } catch (e) { synced = false; }
      }

      _toast(synced
        ? 'Saved — ' + formId.replace(/-/g, ' ') + ' data updated'
        : 'Saved locally — ' + formId.replace(/-/g, ' ') + ' did not reach the server', synced ? 'ok' : 'warn');
      this.close(sectionId);
    },
  };

}(window));
