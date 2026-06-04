/* ═══════════════════════════════════════════════════════════════════════
   Lake Cement MIS — Universal Table Edit, Persist & Audit System
   mis-edit.js  |  v1.0  |  2026-06-03
   -----------------------------------------------------------------------
   Depends on:  auth.js  (canEdit, _writeAudit, showPermDenied, misToast)
   Provides:    MIS_EDIT.init()   — call once on DOMContentLoaded
                MIS_EDIT.enable() — enter edit mode on any registered table
                MIS_EDIT.save()   — save + audit + exit edit mode
                MIS_EDIT.cancel() — restore original + exit
                MIS_EDIT.addRow() — insert blank editable row
                MIS_EDIT.delRow() — delete row + audit
═══════════════════════════════════════════════════════════════════════ */
'use strict';

window.MIS_EDIT = (function () {

  /* ── Internal state ── */
  const _reg  = {};   // tableId → opts
  const _orig = {};   // tableId → original tbody.innerHTML (for cancel)

  /* ══════════════════════════════════════════════════════════════════
     TABLE CONFIGURATION — all editable sections
     sectionTitle : unique substring of <h3 class="mis-sec-title"> text
     permTab      : auth.js permission tab key
     permSection  : auth.js permission section key
     numCols      : col indices rendered as right-aligned numbers
     statusCols   : col indices rendered as badges (uses dropdown in edit)
     statusOptions: dropdown values for status cols
     readonlyCols : col indices never made contenteditable
     noDel        : prevent row delete
     noAdd        : prevent add row
     storageKey   : localStorage key  (auto-generated if omitted)
  ══════════════════════════════════════════════════════════════════ */
  const TABLE_CONFIG = [

    /* ── HR & Admin ── */
    {
      sectionTitle: 'Employee Headcount by Department',
      tab: 'HR & Admin', section: 'strength',
      permTab: 'hr', permSection: 'strength',
      numCols: [1,2,3,4,5,6,7],
    },
    {
      sectionTitle: 'Target vs Actual Strength',
      tab: 'HR & Admin', section: 'strength',
      permTab: 'hr', permSection: 'strength',
      numCols: [2,3,4,5],
    },
    {
      sectionTitle: 'Contract Services',
      tab: 'HR & Admin', section: 'contractors',
      permTab: 'hr', permSection: 'contractors',
      statusCols: [5],
      statusOptions: ['Active','Expired','Expiring','Pending'],
    },

    /* ── Assets ── */
    {
      sectionTitle: 'Network Switches',
      tab: 'Assets', section: 'it',
      permTab: 'assets', permSection: 'it',
      numCols: [4],
    },
    {
      sectionTitle: 'CCTV Cameras',
      tab: 'Assets', section: 'it',
      permTab: 'assets', permSection: 'it',
    },
    {
      sectionTitle: 'Equipment Software Register',
      tab: 'Assets', section: 'it',
      permTab: 'assets', permSection: 'it',
    },
    {
      sectionTitle: 'CAPEX — Budget vs Actual',
      tab: 'Assets', section: 'capex',
      permTab: 'assets', permSection: 'capex',
      numCols: [2,3,4],
    },
    {
      sectionTitle: 'Land Holdings by Location',
      tab: 'Assets', section: 'land',
      permTab: 'assets', permSection: 'land',
      numCols: [1,2,3],
    },
    {
      sectionTitle: 'New Acquisitions',
      tab: 'Assets', section: 'land',
      permTab: 'assets', permSection: 'land',
    },

    /* ── Compliance ── */
    {
      sectionTitle: 'Inventory Closing Positions (Odoo ERP)',
      tab: 'Compliances', section: 'certs',
      permTab: 'compliance', permSection: 'certs',
    },

    /* ── Store ── */
    {
      sectionTitle: 'Physical Stock Audit — 20 Oct 2025',
      tab: 'Purchase & Store', section: 'rawmat',
      permTab: 'store', permSection: 'rawmat',
      numCols: [2],
    },
    {
      sectionTitle: 'Physical Stock Audit — 09 Jul 2025',
      tab: 'Purchase & Store', section: 'rawmat',
      permTab: 'store', permSection: 'rawmat',
      numCols: [2],
    },
    {
      sectionTitle: 'Monthly Audit Progress',
      tab: 'Purchase & Store', section: 'rawmat',
      permTab: 'store', permSection: 'rawmat',
    },
    {
      sectionTitle: 'Deviation Report',
      tab: 'Purchase & Store', section: 'rawmat',
      permTab: 'store', permSection: 'rawmat',
    },
    {
      sectionTitle: 'Inventory Closing Positions',
      tab: 'Purchase & Store', section: 'spares',
      permTab: 'store', permSection: 'spares',
    },
    {
      sectionTitle: 'Inventory by Category',
      tab: 'Purchase & Store', section: 'spares',
      permTab: 'store', permSection: 'spares',
      numCols: [1,2,3],
    },
  ];

  /* ══════════════════════════════════════════════════════════════════
     INIT — discover tables, assign IDs, inject controls, load data
  ══════════════════════════════════════════════════════════════════ */
  function init() {
    TABLE_CONFIG.forEach((cfg, idx) => {
      /* Find the section header by title text */
      let hdr = null;
      document.querySelectorAll('.mis-sec-title').forEach(el => {
        if (!hdr && el.textContent.trim().startsWith(cfg.sectionTitle.slice(0, 30))) {
          hdr = el;
        }
      });
      if (!hdr) return;

      const section = hdr.closest('.mis-section');
      if (!section) return;

      const table = section.querySelector('table');
      if (!table) return;

      /* Assign a stable ID */
      if (!table.id) {
        table.id = 'tbl-me-' + idx;
      }
      const tableId = table.id;

      /* Build storage key */
      const storageKey = cfg.storageKey || ('mis-tbl-' + tableId);

      /* Register */
      _reg[tableId] = Object.assign({}, cfg, { storageKey });

      /* Inject Edit button into section header */
      const hdrEl = hdr.closest('.mis-sec-hdr');
      if (hdrEl && !hdrEl.querySelector('.me-edit-btn-wrap')) {
        const wrap = document.createElement('div');
        wrap.className = 'me-edit-btn-wrap';
        wrap.id = 'edit-btn-' + tableId;
        wrap.style.cssText = 'margin-left:auto;display:flex;gap:6px;align-items:center';
        wrap.innerHTML = _editBtnHtml(tableId);
        hdrEl.appendChild(wrap);
      }

      /* Inject Add Row bar */
      if (!cfg.noAdd) {
        const addBar = document.createElement('div');
        addBar.id = 'add-bar-' + tableId;
        addBar.style.cssText = 'display:none;padding:8px 16px 0';
        addBar.innerHTML = `
          <button class="mis-add-btn" onclick="MIS_EDIT.addRow('${tableId}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Row
          </button>`;
        /* Insert bar between header and table wrap */
        const tableWrap = section.querySelector('.mis-table-wrap');
        if (tableWrap) section.insertBefore(addBar, tableWrap);
      }

      /* Load persisted data */
      _load(tableId);
    });

    /* ── Special: Vehicle table (JS-rendered) ── */
    _initVehicleEdit();

    /* ── Special: Employee Roster (JS-rendered) ── */
    _initEmployeeEdit();

    /* ── Special: AMC table (has its own edit, add Add/Delete capability) ── */
    _initAMCEdit();

    /* ── Special: CSR History (accordion) ── */
    _initCSREdit();
  }

  /* ══════════════════════════════════════════════════════════════════
     LOAD persisted data from localStorage into table tbody
  ══════════════════════════════════════════════════════════════════ */
  function _load(tableId) {
    const opts = _reg[tableId];
    if (!opts) return;
    const saved = localStorage.getItem(opts.storageKey);
    if (!saved) return;
    try {
      const rows = JSON.parse(saved);
      const table = document.getElementById(tableId);
      if (!table) return;
      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      tbody.innerHTML = rows.map(row => _renderRow(row, opts)).join('');
    } catch (e) { /* silently ignore */ }
  }

  function _renderRow(row, opts) {
    const cells = row.map((v, i) => {
      if (opts.statusCols && opts.statusCols.includes(i)) {
        return `<td class="tc">${_badge(String(v))}</td>`;
      }
      if (opts.numCols && opts.numCols.includes(i)) {
        return `<td class="num">${v}</td>`;
      }
      return `<td>${v}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     ENABLE EDIT MODE
  ══════════════════════════════════════════════════════════════════ */
  function enable(tableId) {
    const opts = _reg[tableId];
    if (!opts) return;

    /* Permission check */
    if (typeof canEdit === 'function' && opts.permTab && opts.permSection) {
      if (!canEdit(opts.permTab, opts.permSection)) {
        if (typeof showPermDenied === 'function') {
          showPermDenied('You do not have edit access for: ' + (opts.sectionTitle || opts.section));
        }
        return;
      }
    }

    const table = document.getElementById(tableId);
    if (!table) return;
    const tbody  = table.querySelector('tbody');
    if (!tbody) return;

    /* Backup for cancel */
    _orig[tableId] = tbody.innerHTML;
    table.dataset.editMode = '1';

    /* Make cells editable */
    tbody.querySelectorAll('tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      cells.forEach((cell, cIdx) => {
        if (opts.readonlyCols && opts.readonlyCols.includes(cIdx)) return;

        if (opts.statusCols && opts.statusCols.includes(cIdx)) {
          const current = cell.textContent.trim();
          const options = (opts.statusOptions || ['Active','Expired','Expiring','Pending']).map(s =>
            `<option value="${s}" ${s.toLowerCase() === current.toLowerCase() ? 'selected' : ''}>${s}</option>`
          ).join('');
          cell.dataset.originalVal = current;
          cell.innerHTML = `<select class="mis-status-select" style="width:100%">${options}</select>`;
          return;
        }

        cell.dataset.originalVal = cell.textContent.trim();
        cell.contentEditable = 'true';
        cell.classList.add('edit-on');
      });

      /* Delete button per row */
      if (!opts.noDel) {
        const td = document.createElement('td');
        td.className = 'me-del-cell';
        td.style.cssText = 'width:26px;padding:3px 4px;text-align:center';
        td.innerHTML = `<button class="row-del-btn" onclick="MIS_EDIT.delRow(this,'${tableId}')">×</button>`;
        row.appendChild(td);
      }
    });

    /* Delete column header */
    if (!opts.noDel) {
      const thead = table.querySelector('thead tr');
      if (thead && !thead.querySelector('.me-del-hdr')) {
        const th = document.createElement('th');
        th.className = 'me-del-hdr';
        th.style.width = '26px';
        thead.appendChild(th);
      }
    }

    /* Swap buttons */
    _setButtons(tableId, true);

    /* Show Add Row bar */
    const addBar = document.getElementById('add-bar-' + tableId);
    if (addBar && !opts.noAdd) addBar.style.display = '';
  }

  /* ══════════════════════════════════════════════════════════════════
     SAVE
  ══════════════════════════════════════════════════════════════════ */
  function save(tableId) {
    const opts  = _reg[tableId];
    if (!opts) return;
    const table = document.getElementById(tableId);
    if (!table) return;
    const tbody = table.querySelector('tbody');

    /* Collect column headers for audit labels */
    const headers = [];
    table.querySelectorAll('thead th:not(.me-del-hdr)').forEach(th => headers.push(th.textContent.trim()));

    const rows    = [];
    const changes = [];

    tbody.querySelectorAll('tr').forEach((row, rIdx) => {
      const rowData = [];

      row.querySelectorAll('td:not(.me-del-cell)').forEach((cell, cIdx) => {
        const sel = cell.querySelector('select');
        let newVal;

        if (sel) {
          newVal = sel.value;
          cell.innerHTML = _badge(newVal);
        } else {
          newVal = cell.textContent.trim();
          cell.contentEditable = 'false';
          cell.removeAttribute('contenteditable');
          cell.classList.remove('edit-on');
        }

        const oldVal = cell.dataset.originalVal || '';
        if (newVal !== oldVal) {
          const fieldName = headers[cIdx] || ('Col ' + (cIdx + 1));
          changes.push({ field: fieldName, old: oldVal, new: newVal, row: rIdx + 1 });
        }
        cell.removeAttribute('data-original-val');
        rowData.push(newVal);
      });

      /* Remove delete cell */
      row.querySelector('.me-del-cell')?.remove();
      rows.push(rowData);
    });

    /* Remove delete header */
    table.querySelector('.me-del-hdr')?.remove();

    /* Persist */
    localStorage.setItem(opts.storageKey, JSON.stringify(rows));

    /* Audit */
    if (typeof _writeAudit === 'function' && changes.length > 0) {
      changes.forEach(c => {
        _writeAudit('EDIT', opts.tab || '—', opts.sectionTitle || opts.section, c.field, c.old, c.new);
      });
    }

    delete table.dataset.editMode;
    delete _orig[tableId];

    _setButtons(tableId, false);
    const addBar = document.getElementById('add-bar-' + tableId);
    if (addBar) addBar.style.display = 'none';

    if (typeof misToast === 'function') misToast('Saved successfully');
  }

  /* ══════════════════════════════════════════════════════════════════
     CANCEL
  ══════════════════════════════════════════════════════════════════ */
  function cancel(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;

    if (_orig[tableId] != null) {
      table.querySelector('tbody').innerHTML = _orig[tableId];
      delete _orig[tableId];
    }

    table.querySelector('.me-del-hdr')?.remove();
    delete table.dataset.editMode;
    _setButtons(tableId, false);

    const addBar = document.getElementById('add-bar-' + tableId);
    if (addBar) addBar.style.display = 'none';
  }

  /* ══════════════════════════════════════════════════════════════════
     ADD ROW
  ══════════════════════════════════════════════════════════════════ */
  function addRow(tableId) {
    const opts  = _reg[tableId];
    if (!opts) return;
    const table = document.getElementById(tableId);
    if (!table) return;

    const colCount = table.querySelectorAll('thead th:not(.me-del-hdr)').length || 4;
    const tr       = document.createElement('tr');

    for (let i = 0; i < colCount; i++) {
      const td = document.createElement('td');
      td.dataset.originalVal = '';

      if (opts.statusCols && opts.statusCols.includes(i)) {
        const opts2 = opts.statusOptions || ['Active','Expired','Expiring','Pending'];
        td.innerHTML = `<select class="mis-status-select" style="width:100%">${opts2.map(s => `<option>${s}</option>`).join('')}</select>`;
        td.className = 'tc';
      } else {
        td.contentEditable = 'true';
        td.classList.add('edit-on');
        if (opts.numCols && opts.numCols.includes(i)) td.classList.add('num');
        td.style.minWidth = '50px';
      }
      tr.appendChild(td);
    }

    /* Delete button */
    if (!opts.noDel) {
      const td2 = document.createElement('td');
      td2.className = 'me-del-cell';
      td2.style.cssText = 'width:26px;padding:3px 4px;text-align:center';
      td2.innerHTML = `<button class="row-del-btn" onclick="MIS_EDIT.delRow(this,'${tableId}')">×</button>`;
      tr.appendChild(td2);
    }

    table.querySelector('tbody').appendChild(tr);
    tr.querySelector('[contenteditable]')?.focus();

    if (typeof _writeAudit === 'function') {
      _writeAudit('ADD', opts.tab || '—', opts.sectionTitle || opts.section, '—', '—', 'New row added');
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     DELETE ROW
  ══════════════════════════════════════════════════════════════════ */
  function delRow(btn, tableId) {
    const row  = btn.closest('tr');
    const opts = _reg[tableId] || {};
    const lbl  = (row.querySelector('td:not(.me-del-cell)')?.textContent || '').trim().slice(0, 60);

    if (typeof _writeAudit === 'function') {
      _writeAudit('DELETE', opts.tab || '—', opts.sectionTitle || opts.section, '—', lbl, '(deleted)');
    }
    row.remove();
  }

  /* ══════════════════════════════════════════════════════════════════
     BADGE RENDERER
  ══════════════════════════════════════════════════════════════════ */
  function _badge(status) {
    const s = String(status || '').toLowerCase();
    if (['active','valid','complied','settled','completed','on track'].includes(s))
      return `<span class="mis-badge valid">${status}</span>`;
    if (['expired','not complied','inactive','overdue'].includes(s))
      return `<span class="mis-badge expired">${status}</span>`;
    if (['expiring','partial','pending','renewal','ongoing','watch'].includes(s))
      return `<span class="mis-badge expiring">${status}</span>`;
    return `<span class="mis-badge" style="background:#F1F5F9;color:#64748B;border:1px solid #CBD5E1">${status}</span>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     BUTTON HTML helpers
  ══════════════════════════════════════════════════════════════════ */
  function _editBtnHtml(tableId) {
    return `<button class="mis-edit-btn" onclick="MIS_EDIT.enable('${tableId}')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>Edit</button>`;
  }

  function _setButtons(tableId, isEditing) {
    const wrap = document.getElementById('edit-btn-' + tableId);
    if (!wrap) return;
    if (isEditing) {
      wrap.innerHTML = `
        <button class="mis-edit-btn active" onclick="MIS_EDIT.save('${tableId}')" style="background:var(--navy);color:white;border-color:var(--navy)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg>Save
        </button>
        <button class="mis-edit-btn" onclick="MIS_EDIT.cancel('${tableId}')">Cancel</button>`;
    } else {
      wrap.innerHTML = _editBtnHtml(tableId);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     SPECIAL: VEHICLE TABLE (JS-rendered, already has id="veh-table")
  ══════════════════════════════════════════════════════════════════ */
  function _initVehicleEdit() {
    const tableId    = 'veh-table';
    const storageKey = 'mis-tbl-vehicles';
    const tab        = 'Assets';
    const section    = 'vehicles';

    _reg[tableId] = { storageKey, tab, section, sectionTitle: 'Fleet Register', permTab: 'assets', permSection: 'vehicles' };

    /* Inject Edit button into Fleet Register header */
    const hdr = Array.from(document.querySelectorAll('.mis-sec-title'))
      .find(el => el.textContent.includes('Fleet Register'));
    if (hdr) {
      const hdrEl = hdr.closest('.mis-sec-hdr');
      if (hdrEl && !hdrEl.querySelector('#edit-btn-veh-table')) {
        const wrap = document.createElement('div');
        wrap.id    = 'edit-btn-veh-table';
        wrap.style.cssText = 'display:flex;gap:6px;align-items:center';
        wrap.innerHTML = _editBtnHtml(tableId);
        hdrEl.appendChild(wrap);
      }

      /* Add Row bar */
      const section2 = hdr.closest('.mis-section');
      if (section2) {
        const addBar = document.createElement('div');
        addBar.id    = 'add-bar-veh-table';
        addBar.style.cssText = 'display:none;padding:8px 16px 0';
        addBar.innerHTML = `
          <button class="mis-add-btn" onclick="MIS_EDIT.addRow('veh-table')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Vehicle
          </button>`;
        const tw = section2.querySelector('.mis-table-wrap');
        if (tw) section2.insertBefore(addBar, tw);
      }
    }

    /* If localStorage has saved vehicles, render those instead of VEH_DATA */
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const rows = JSON.parse(saved);
        const tbody = document.getElementById('veh-tbody');
        if (tbody) {
          tbody.innerHTML = rows.map(r => `<tr>${r.map(v => `<td>${v}</td>`).join('')}</tr>`).join('');
          const lbl = document.getElementById('veh-count-lbl');
          if (lbl) lbl.textContent = rows.length + ' vehicles (saved)';
        }
      } catch {}
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     SPECIAL: EMPLOYEE ROSTER (JS-rendered, id="emp-table")
  ══════════════════════════════════════════════════════════════════ */
  function _initEmployeeEdit() {
    const tableId    = 'emp-table';
    const storageKey = 'mis-tbl-employees';
    _reg[tableId]    = {
      storageKey, tab: 'HR & Admin', section: 'roster',
      sectionTitle: 'Employee Roster', permTab: 'hr', permSection: 'roster',
      numCols: [],
    };

    /* Inject Edit button */
    const hdr = document.querySelector('#hr-roster .mis-sec-hdr');
    if (hdr && !hdr.querySelector('#edit-btn-emp-table')) {
      const wrap = document.createElement('div');
      wrap.id    = 'edit-btn-emp-table';
      wrap.style.cssText = 'display:flex;gap:6px;align-items:center';
      wrap.innerHTML = _editBtnHtml(tableId);
      hdr.appendChild(wrap);
    }

    /* Add Row bar */
    const rosterPanel = document.getElementById('hr-roster');
    if (rosterPanel) {
      const addBar = document.createElement('div');
      addBar.id    = 'add-bar-emp-table';
      addBar.style.cssText = 'display:none;padding:8px 16px 0';
      addBar.innerHTML = `
        <button class="mis-add-btn" onclick="MIS_EDIT.addRow('emp-table')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Employee
        </button>`;
      const tw = rosterPanel.querySelector('.mis-table-wrap');
      if (tw) rosterPanel.querySelector('.mis-section').insertBefore(addBar, tw);
    }

    /* Load saved employees (overrides the JS-rendered EMP_DATA) */
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const rows = JSON.parse(saved);
        const tbody = document.getElementById('emp-tbody');
        if (tbody) {
          tbody.innerHTML = rows.map(r => `<tr>${r.map(v => `<td>${v}</td>`).join('')}</tr>`).join('');
          const lbl = document.getElementById('emp-count-lbl');
          if (lbl) lbl.textContent = rows.length + ' employees (saved)';
        }
      } catch {}
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     SPECIAL: AMC TABLE — Add "Add AMC" and delete row to existing system
  ══════════════════════════════════════════════════════════════════ */
  function _initAMCEdit() {
    const tableId    = 'store-amc';
    const storageKey = 'mis-tbl-amc-rows';
    const tab        = 'Purchase & Store';
    const sectionTitle = 'Annual Maintenance Contracts';

    _reg[tableId] = { storageKey, tab, section: 'amc', sectionTitle, permTab: 'store', permSection: 'amc' };

    /* Inject Add AMC bar below the amc edit button div */
    const hdr = Array.from(document.querySelectorAll('.mis-sec-title'))
      .find(el => el.textContent.includes('Annual Maintenance Contracts'));
    if (!hdr) return;

    const section = hdr.closest('.mis-section');
    if (!section) return;

    /* Add Row bar (only visible in AMC edit mode) */
    let addBar = document.getElementById('amc-add-row-bar');
    if (!addBar) {
      addBar = document.createElement('div');
      addBar.id = 'amc-add-row-bar';
      addBar.style.cssText = 'display:none;padding:8px 16px 0';
      addBar.innerHTML = `
        <button class="mis-add-btn" onclick="_amcAddRow()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add AMC Contract
        </button>`;
      const tw = section.querySelector('.mis-table-wrap');
      if (tw) section.insertBefore(addBar, tw);
    }

    /* Load persisted extra AMC rows */
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const rows = JSON.parse(saved);
        const tbody = document.querySelector('#store-amc tbody');
        if (tbody) {
          rows.forEach(r => {
            const tr = document.createElement('tr');
            tr.dataset.amcExtra = '1';
            tr.innerHTML = r.map(v => `<td>${v}</td>`).join('');
            tbody.appendChild(tr);
          });
        }
      } catch {}
    }
  }

  /* Add blank AMC row in edit mode */
  window._amcAddRow = function() {
    const tbody = document.querySelector('#store-amc tbody');
    if (!tbody) return;
    const sn = tbody.querySelectorAll('tr').length + 1;
    const tr = document.createElement('tr');
    tr.dataset.amcExtra = '1';
    tr.innerHTML = `
      <td class="mis-editable" contenteditable="true" class="edit-on">${sn}</td>
      <td class="mis-editable" contenteditable="true" class="edit-on">—</td>
      <td class="mis-editable" contenteditable="true" class="edit-on"><strong>New Vendor</strong></td>
      <td class="mis-editable" contenteditable="true" class="edit-on" style="white-space:normal">Description</td>
      <td class="mis-editable tc" contenteditable="true" class="edit-on">01.01.2026</td>
      <td class="mis-editable tc" contenteditable="true" class="edit-on">31.12.2026</td>
      <td class="mis-editable" contenteditable="true" class="edit-on">—</td>
      <td class="mis-editable tr" contenteditable="true" class="edit-on">—</td>
      <td class="tc"><select class="mis-status-select">
        <option>Active</option><option>Expired</option><option>Expiring</option>
      </select></td>`;
    tbody.appendChild(tr);
    if (typeof _writeAudit === 'function') {
      _writeAudit('ADD', 'Purchase & Store', 'AMC Contracts', '—', '—', 'New AMC row added');
    }
  };

  /* ══════════════════════════════════════════════════════════════════
     SPECIAL: CSR HISTORY (accordion) — Add Project button per year
  ══════════════════════════════════════════════════════════════════ */
  function _initCSREdit() {
    const csrPanel = document.getElementById('hr-csr');
    if (!csrPanel) return;

    /* Add a global "Add CSR Project" button to the section header */
    const secHdr = csrPanel.querySelector('.mis-sec-hdr');
    if (secHdr && !secHdr.querySelector('#csr-add-btn')) {
      const btn = document.createElement('button');
      btn.id = 'csr-add-btn';
      btn.className = 'mis-edit-btn';
      btn.style.cssText = 'margin-left:auto;border-color:#10B981;color:#059669';
      btn.onclick = openCSRAddModal;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add CSR Project`;
      secHdr.appendChild(btn);
    }

    /* Permission check — hide button if not allowed */
    if (typeof canEdit === 'function' && !canEdit('hr', 'csr')) {
      const btn = document.getElementById('csr-add-btn');
      if (btn) btn.style.display = 'none';
    }

    /* Load persisted CSR extra rows */
    const saved = localStorage.getItem('mis-csr-extra');
    if (saved) {
      try {
        const extras = JSON.parse(saved);
        extras.forEach(row => _appendCSRRow(row));
      } catch {}
    }
  }

  function _appendCSRRow(row) {
    /* Find the <details> for the right year */
    let target = null;
    document.querySelectorAll('.csr-yr-label').forEach(el => {
      if (el.textContent.trim() === String(row.year)) target = el.closest('details');
    });
    if (!target) return;
    const tbody = target.querySelector('tbody');
    if (!tbody) return;
    const rIdx = tbody.querySelectorAll('tr').length + 1;
    const tr   = document.createElement('tr');
    tr.dataset.csrExtra = '1';
    tr.innerHTML = `
      <td>${rIdx}</td>
      <td style="white-space:normal;line-height:1.4">${row.activity}</td>
      <td class="tc">${row.date}</td>
      <td class="tc">${row.cost}</td>
      <td class="tc"><span style="color:#10B981;font-weight:600">${row.status}</span></td>`;
    tbody.appendChild(tr);
  }

  function openCSRAddModal() {
    if (typeof canEdit === 'function' && !canEdit('hr', 'csr')) {
      if (typeof showPermDenied === 'function') showPermDenied('No edit access for CSR History');
      return;
    }
    /* Build inline modal */
    let modal = document.getElementById('csr-add-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'csr-add-modal';
      modal.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;
        display:flex;align-items:center;justify-content:center`;
      modal.innerHTML = `
        <div style="background:white;border-radius:12px;padding:28px;width:480px;max-width:95vw;box-shadow:0 20px 60px rgba(0,0,0,.3)">
          <h3 style="margin:0 0 18px;font-size:15px;font-weight:800;color:var(--navy)">Add CSR Project</h3>
          <div style="display:grid;gap:12px">
            <div><label style="font-size:11px;font-weight:700;color:var(--navy);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Year</label>
              <input id="csr-m-year" type="number" value="2026" style="width:100%;font-family:inherit;font-size:13px;padding:8px 10px;border:1.5px solid var(--border);border-radius:7px;outline:none" /></div>
            <div><label style="font-size:11px;font-weight:700;color:var(--navy);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Activity / Description</label>
              <textarea id="csr-m-activity" rows="3" style="width:100%;font-family:inherit;font-size:13px;padding:8px 10px;border:1.5px solid var(--border);border-radius:7px;outline:none;resize:vertical"></textarea></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div><label style="font-size:11px;font-weight:700;color:var(--navy);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Date</label>
                <input id="csr-m-date" type="text" placeholder="Jan 2026" style="width:100%;font-family:inherit;font-size:13px;padding:8px 10px;border:1.5px solid var(--border);border-radius:7px;outline:none" /></div>
              <div><label style="font-size:11px;font-weight:700;color:var(--navy);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Cost (TSH)</label>
                <input id="csr-m-cost" type="text" placeholder="TSH 500,000" style="width:100%;font-family:inherit;font-size:13px;padding:8px 10px;border:1.5px solid var(--border);border-radius:7px;outline:none" /></div>
            </div>
            <div><label style="font-size:11px;font-weight:700;color:var(--navy);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Status</label>
              <select id="csr-m-status" style="width:100%;font-family:inherit;font-size:13px;padding:8px 10px;border:1.5px solid var(--border);border-radius:7px;outline:none">
                <option>Completed</option><option>Ongoing</option><option>Planned</option>
              </select></div>
          </div>
          <div style="display:flex;gap:10px;margin-top:20px">
            <button onclick="MIS_EDIT._saveCSR()" style="flex:1;padding:10px;background:var(--navy);color:white;border:none;border-radius:7px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer">Add Project</button>
            <button onclick="document.getElementById('csr-add-modal').style.display='none'" style="flex:1;padding:10px;background:var(--off-white);color:var(--text-muted);border:1.5px solid var(--border);border-radius:7px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
  }

  function _saveCSR() {
    const year     = document.getElementById('csr-m-year')?.value?.trim() || '2026';
    const activity = document.getElementById('csr-m-activity')?.value?.trim();
    const date     = document.getElementById('csr-m-date')?.value?.trim()     || '—';
    const cost     = document.getElementById('csr-m-cost')?.value?.trim()     || '—';
    const status   = document.getElementById('csr-m-status')?.value           || 'Completed';

    if (!activity) { alert('Please enter the activity description.'); return; }

    const row = { year, activity, date, cost, status };
    _appendCSRRow(row);

    /* Persist */
    const extras = JSON.parse(localStorage.getItem('mis-csr-extra') || '[]');
    extras.push(row);
    localStorage.setItem('mis-csr-extra', JSON.stringify(extras));

    if (typeof _writeAudit === 'function') {
      _writeAudit('ADD', 'HR & Admin', 'CSR History', 'Activity', '—', activity + ' (' + year + ')');
    }

    if (typeof misToast === 'function') misToast('CSR project added');
    document.getElementById('csr-add-modal').style.display = 'none';

    /* Clear form */
    ['csr-m-activity','csr-m-date','csr-m-cost'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════════════ */
  return {
    init,
    enable,
    save,
    cancel,
    addRow,
    delRow,
    _saveCSR,      /* called from inline modal button */
    _reg,          /* exposed for applyEditButtonPermissions() in auth.js */
  };

})();
