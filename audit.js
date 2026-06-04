/* ═══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — MIS Audit Log Module
   audit.js  |  v2.0  |  2026-06-04
   -----------------------------------------------------------------------
   Depends on: auth.js  (for _writeAudit, getCurrentUser, canViewAudit,
                          PERMISSIONS)
   Provides:   auditLog(), getAuditLog(), renderAuditPanel(),
               exportAuditLog(), renderAccessMatrix()
═══════════════════════════════════════════════════════════════════════ */
'use strict';

const _AUDIT_KEY  = 'lcl_audit_log';
const _AUDIT_MAX  = 2000;
const _PAGE_SIZE  = 50;

let _auditPage    = 0;
let _auditFilters = {};

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — write an audit entry
   action  : 'EDIT' | 'ADD' | 'DELETE' | 'UPLOAD' | 'LOGIN' | 'LOGOUT' | 'EXPORT'
   tab     : MIS tab name e.g. 'HR & Admin', 'Compliances'
   section : sub-section name e.g. 'Legal Cases', 'AMC Contracts'
   field   : column/field changed
   oldVal  : previous value ('' if ADD)
   newVal  : new value ('' if DELETE)
══════════════════════════════════════════════════════════════════════ */
function auditLog(action, tab, section, field, oldVal, newVal) {
  _writeAudit(action, tab, section, field, oldVal, newVal);
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — retrieve audit log with optional filters
   filters: { user, tab, section, action, fromDate (YYYY-MM-DD), toDate }
══════════════════════════════════════════════════════════════════════ */
function getAuditLog(filters) {
  filters = filters || {};
  let log = [];
  try { log = JSON.parse(localStorage.getItem(_AUDIT_KEY) || '[]'); } catch {}

  if (filters.user)     log = log.filter(e => (e.user||'').toLowerCase().includes(filters.user.toLowerCase()));
  if (filters.tab)      log = log.filter(e => e.tab === filters.tab);
  if (filters.section)  log = log.filter(e => e.section === filters.section);
  if (filters.action)   log = log.filter(e => e.action === filters.action);
  if (filters.fromDate) log = log.filter(e => e.ts >= filters.fromDate);
  if (filters.toDate)   log = log.filter(e => e.ts <= filters.toDate + 'T23:59:59.999Z');

  return log;
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — render the audit panel in the DOM
   Call after mis tab switches to 'audit'
══════════════════════════════════════════════════════════════════════ */
function renderAuditPanel(filters) {
  if (filters !== undefined) {
    _auditFilters = filters || {};
    _auditPage = 0;
  }

  const tbody    = document.getElementById('audit-tbody');
  const countEl  = document.getElementById('audit-count-lbl');
  const pageInfo = document.getElementById('audit-page-info');
  const prevBtn  = document.getElementById('audit-prev-btn');
  const nextBtn  = document.getElementById('audit-next-btn');
  if (!tbody) return;

  const log = getAuditLog(_auditFilters);
  const total = log.length;
  const totalPages = Math.max(1, Math.ceil(total / _PAGE_SIZE));
  if (_auditPage >= totalPages) _auditPage = totalPages - 1;
  if (_auditPage < 0) _auditPage = 0;

  const pageLog = log.slice(_auditPage * _PAGE_SIZE, (_auditPage + 1) * _PAGE_SIZE);

  if (countEl) countEl.textContent = total.toLocaleString() + ' entr' + (total === 1 ? 'y' : 'ies');

  if (pageInfo) {
    const from = total === 0 ? 0 : _auditPage * _PAGE_SIZE + 1;
    const to   = Math.min((_auditPage + 1) * _PAGE_SIZE, total);
    pageInfo.textContent = total === 0 ? 'No entries' : `${from}–${to} of ${total.toLocaleString()}`;
  }
  if (prevBtn) prevBtn.disabled = (_auditPage === 0);
  if (nextBtn) nextBtn.disabled = (_auditPage >= totalPages - 1);

  if (pageLog.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="audit-empty">No audit entries found for the selected filters.</td></tr>';
    return;
  }

  const ACTION_COLORS = {
    LOGIN:  '#6366F1', LOGOUT: '#94A3B8',
    ADD:    '#10B981', EDIT:   '#3B82F6',
    DELETE: '#EF4444', UPLOAD: '#F59E0B',
    EXPORT: '#8B5CF6', DEFAULT:'#64748B',
  };

  tbody.innerHTML = pageLog.map(e => {
    let ts = '—', timeStr = '—';
    try {
      const d = new Date(e.ts);
      ts      = d.toLocaleDateString('en-GB',  { day:'2-digit', month:'short', year:'numeric' });
      timeStr = d.toLocaleTimeString('en-GB',  { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    } catch {}

    const color  = ACTION_COLORS[e.action] || ACTION_COLORS.DEFAULT;
    const change = e.oldVal && e.oldVal !== '—'
      ? `<span style="color:#EF4444;text-decoration:line-through">${escHtml(e.oldVal)}</span>&nbsp;→&nbsp;<span style="color:#10B981">${escHtml(e.newVal)}</span>`
      : escHtml(e.newVal || '—');

    const roleLabel = escHtml(e.role || '—');

    return `<tr>
      <td style="white-space:nowrap;font-size:10px">
        <span style="color:var(--text-muted,#64748B)">${ts}</span><br/>
        <strong style="font-size:10.5px">${timeStr}</strong>
      </td>
      <td>
        <strong style="font-size:11px">${escHtml(e.user||'—')}</strong>
      </td>
      <td style="font-size:10px;color:var(--text-muted,#64748B)">${escHtml(e.dept||'—')}</td>
      <td style="font-size:10px">
        <span class="audit-role-badge">${roleLabel}</span>
      </td>
      <td>
        <span class="audit-action-badge" style="background:${color}15;color:${color};border:1px solid ${color}33">
          ${escHtml(e.action||'—')}
        </span>
      </td>
      <td style="font-size:10px">${escHtml(e.tab||'—')}</td>
      <td style="font-size:10px">${escHtml(e.section||'—')}</td>
      <td style="font-size:10px;color:var(--text-muted,#64748B)">${escHtml(e.field||'—')}</td>
      <td style="font-size:10px;max-width:220px;word-break:break-word">${change}</td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — navigate audit pages
══════════════════════════════════════════════════════════════════════ */
function goAuditPage(dir) {
  _auditPage = Math.max(0, _auditPage + dir);
  renderAuditPanel();
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — export audit log as CSV
══════════════════════════════════════════════════════════════════════ */
function exportAuditLog() {
  if (!canViewAudit()) { showPermDenied(); return; }
  const log = getAuditLog();
  const header = ['Timestamp','User','Department','Role','Action','Tab','Section','Field','Old Value','New Value'];
  const rows = [header].concat(log.map(e => [
    e.ts, e.user, e.dept, e.role, e.action, e.tab, e.section, e.field, e.oldVal, e.newVal
  ]));
  const csv = rows.map(r => r.map(v => '"' + String(v||'').replace(/"/g,'""') + '"').join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type:'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'LCL-MIS-AuditLog-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  auditLog('EXPORT', 'Audit', 'Audit Trail', '—', '—', log.length + ' entries exported to CSV');
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — clear audit log (admin/md only)
══════════════════════════════════════════════════════════════════════ */
function clearAuditLog() {
  if (!canViewAudit()) { showPermDenied(); return; }
  if (!confirm('Clear ALL audit entries? This action cannot be undone.')) return;
  localStorage.removeItem(_AUDIT_KEY);
  _auditPage = 0;
  renderAuditPanel({});
  refreshAuditKV();
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — apply filters from the filter bar
══════════════════════════════════════════════════════════════════════ */
function applyAuditFilters() {
  const filters = {
    user:     (document.getElementById('af-user')     ||{}).value || '',
    action:   (document.getElementById('af-action')   ||{}).value || '',
    tab:      (document.getElementById('af-tab')      ||{}).value || '',
    fromDate: (document.getElementById('af-from')     ||{}).value || '',
    toDate:   (document.getElementById('af-to')       ||{}).value || '',
  };
  Object.keys(filters).forEach(k => { if (!filters[k]) delete filters[k]; });
  _auditPage = 0;
  renderAuditPanel(filters);
}

function resetAuditFilters() {
  ['af-user','af-action','af-tab','af-from','af-to'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  _auditPage = 0;
  renderAuditPanel({});
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — summary stats for the audit KV strip
══════════════════════════════════════════════════════════════════════ */
function getAuditStats(log) {
  log = log || getAuditLog();
  const today = new Date().toISOString().slice(0, 10);
  const users   = new Set(log.map(e => e.user)).size;
  const edits   = log.filter(e => e.action === 'EDIT').length;
  const adds    = log.filter(e => ['ADD','UPLOAD'].includes(e.action)).length;
  const deletes = log.filter(e => e.action === 'DELETE').length;
  const logins  = log.filter(e => e.action === 'LOGIN').length;
  const todayN  = log.filter(e => e.ts && e.ts.startsWith(today)).length;
  return { total: log.length, users, edits, adds, deletes, logins, today: todayN };
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — update the KV cards in the audit panel
══════════════════════════════════════════════════════════════════════ */
function refreshAuditKV() {
  const stats = getAuditStats();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('audit-total-kv',  stats.total.toLocaleString());
  set('audit-users-kv',  stats.users);
  set('audit-edits-kv',  stats.edits);
  set('audit-adds-kv',   stats.adds);
  set('audit-today-kv',  stats.today);
  set('audit-logins-kv', stats.logins);
  set('audit-count-lbl', stats.total.toLocaleString() + ' entr' + (stats.total === 1 ? 'y' : 'ies'));
}

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC — render access rights matrix
   Shows PERMISSIONS object as a colour-coded grid (admin/md only)
══════════════════════════════════════════════════════════════════════ */
function renderAccessMatrix() {
  const container = document.getElementById('access-matrix-container');
  if (!container) return;
  if (typeof PERMISSIONS === 'undefined') {
    container.innerHTML = '<p style="padding:16px;color:#64748B;font-size:12px">Permissions data not available.</p>';
    return;
  }

  const ROLE_LABELS = {
    md: 'MD / CEO', admin: 'System Admin', management: 'Senior Mgt',
    hr: 'HR & Admin', finance: 'Finance', stores: 'Stores',
    cpp: 'Power Plant', pm: 'Projects & Maint', it: 'IT',
    logistics: 'Logistics', mining: 'Mining', production: 'Production & QC',
  };

  /* Column groups: [ group label, permKey, [ [colLabel, sectionKey], … ] ] */
  const COL_GROUPS = [
    { label: 'HR & Admin',    tab: 'hr',         cols: [['Strength','strength'],['Roster','roster'],['Contractors','contractors'],['CSR','csr']] },
    { label: 'Assets',        tab: 'assets',      cols: [['IT','it'],['Vehicles','vehicles'],['Spares','spares'],['CAPEX','capex'],['Land','land']] },
    { label: 'Compliance',    tab: 'compliance',  cols: [['Certs','certs'],['ML/PL','mlpl'],['Legal','legal'],['Insurance','insurance']] },
    { label: 'Store',         tab: 'store',       cols: [['Raw Mat','rawmat'],['Spares','spares'],['AMC','amc']] },
  ];

  const SPECIAL_COLS = [
    ['View Audit', 'canViewAudit'],
    ['Manage Users', 'canManageUsers'],
    ['Export', 'canExport'],
  ];

  const KPI_COLS = [
    ['KPI Fill', 'fill'],
    ['KPI Daily', 'daily'],
  ];

  function badge(level) {
    if (level === 'edit') return '<span class="arm-badge arm-edit">EDIT</span>';
    if (level === 'view') return '<span class="arm-badge arm-view">VIEW</span>';
    if (level === 'own')  return '<span class="arm-badge arm-own">OWN</span>';
    if (level === null || level === undefined) return '<span class="arm-badge arm-none">—</span>';
    return `<span class="arm-badge arm-edit">${escHtml(String(level))}</span>`;
  }

  function tick(val) {
    return val
      ? '<span class="arm-tick">✓</span>'
      : '<span class="arm-badge arm-none">—</span>';
  }

  /* Build header */
  const groupHeaders = COL_GROUPS.map(g =>
    `<th colspan="${g.cols.length}" class="arm-group-hdr">${g.label}</th>`
  ).join('');
  const specialGroupHdr = `<th colspan="${SPECIAL_COLS.length + KPI_COLS.length}" class="arm-group-hdr arm-special-grp">Permissions</th>`;

  const colHeaders = COL_GROUPS.map(g =>
    g.cols.map(([label]) => `<th class="arm-col-hdr" title="${g.label}">${label}</th>`).join('')
  ).join('');
  const specialColHdrs = SPECIAL_COLS.map(([label]) => `<th class="arm-col-hdr arm-special-col">${label}</th>`).join('');
  const kpiColHdrs     = KPI_COLS.map(([label])     => `<th class="arm-col-hdr arm-kpi-col">${label}</th>`).join('');

  const thead = `<thead>
    <tr>
      <th class="arm-role-hdr" rowspan="2">Role</th>
      ${groupHeaders}${specialGroupHdr}
    </tr>
    <tr>${colHeaders}${specialColHdrs}${kpiColHdrs}</tr>
  </thead>`;

  /* Build rows */
  const roles = Object.keys(PERMISSIONS);
  const tbody = '<tbody>' + roles.map(role => {
    const p = PERMISSIONS[role];
    const sectionCells = COL_GROUPS.map(g =>
      g.cols.map(([, sec]) => {
        const level = (p[g.tab] && p[g.tab][sec] !== undefined) ? p[g.tab][sec] : null;
        return `<td class="arm-cell">${badge(level)}</td>`;
      }).join('')
    ).join('');

    const specialCells = SPECIAL_COLS.map(([, key]) =>
      `<td class="arm-cell">${tick(p[key])}</td>`
    ).join('');

    const kpiCells = KPI_COLS.map(([, key]) =>
      `<td class="arm-cell">${tick(p.kpi && p.kpi[key])}</td>`
    ).join('');

    /* KPI depts summary */
    const depts = p.kpi && p.kpi.depts;
    const deptsLabel = !depts ? '—' : (depts === 'all' ? '<span class="arm-tick">All</span>' : `<span class="arm-kpi-depts" title="${depts.join(', ')}">${depts.length} dept${depts.length !== 1 ? 's' : ''}</span>`);

    return `<tr>
      <td class="arm-role-cell">
        <strong>${escHtml(ROLE_LABELS[role] || role)}</strong>
        <span class="arm-role-slug">${escHtml(role)}</span>
      </td>
      ${sectionCells}${specialCells}${kpiCells}
    </tr>`;
  }).join('') + '</tbody>';

  /* Legend */
  const legend = `<div class="arm-legend">
    <span class="arm-badge arm-edit">EDIT</span> Full edit access &nbsp;
    <span class="arm-badge arm-view">VIEW</span> Read-only &nbsp;
    <span class="arm-badge arm-own">OWN</span> Own dept only &nbsp;
    <span class="arm-badge arm-none">—</span> No access &nbsp;
    <span class="arm-tick">✓</span> Enabled
  </div>`;

  container.innerHTML = legend + `<div class="mis-table-wrap arm-table-wrap">
    <table class="mis-table arm-table">
      ${thead}${tbody}
    </table>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   HELPER — HTML escape
══════════════════════════════════════════════════════════════════════ */
function escHtml(s) {
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
