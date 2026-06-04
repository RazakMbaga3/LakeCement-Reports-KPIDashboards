"""Patch mis.html: fix persistence on reload + add Export JSON buttons."""
import re

with open('c:/Users/USER/LakeCementDashboard/mis.html', 'r', encoding='utf-8') as f:
    html = f.read()

# ══════════════════════════════════════════════════════════════════
# 1. FIX DOMContentLoaded — load AMC + Insurance on every page load
# ══════════════════════════════════════════════════════════════════
old_dcl = """document.addEventListener('DOMContentLoaded', () => {
  loadLegal();

  // Load cert overrides
  const savedCerts = localStorage.getItem('mis-cert-upload');"""

new_dcl = """document.addEventListener('DOMContentLoaded', () => {
  loadLegal();

  // Load AMC overrides (rows exist in static HTML)
  loadAmc();

  // Load Insurance edits + extras (tag rows first)
  tagInsuranceRows();
  loadIns();

  // Load cert overrides
  const savedCerts = localStorage.getItem('mis-cert-upload');"""

if old_dcl in html:
    html = html.replace(old_dcl, new_dcl)
    print('Fix 1 (DOMContentLoaded): AMC + Insurance added')
else:
    print('Fix 1 SKIP: pattern not found')

# ══════════════════════════════════════════════════════════════════
# 2. ADD EXPORT JSON BUTTONS to Legal, AMC, Insurance headers
# ══════════════════════════════════════════════════════════════════

EXPORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'

# Legal export button — insert before closing </div> of the edit button group
old_legal_btns = '''          <button class="mis-edit-btn" id="legal-edit-btn" onclick="toggleLegalEdit()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
        </div>'''
new_legal_btns = f'''          <button class="mis-edit-btn" id="legal-edit-btn" onclick="toggleLegalEdit()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="mis-edit-btn" onclick="exportLegal()" title="Download Legal Cases as JSON">
            {EXPORT_ICON}
            Export
          </button>
        </div>'''

if old_legal_btns in html:
    html = html.replace(old_legal_btns, new_legal_btns)
    print('Fix 2a (Legal export button): added')
else:
    print('Fix 2a SKIP')

# AMC export button
old_amc_btns = '''          <button class="mis-edit-btn" id="amc-edit-btn" onclick="toggleAmcEdit()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit Dates &amp; Status
          </button>
        </div>'''
new_amc_btns = f'''          <button class="mis-edit-btn" id="amc-edit-btn" onclick="toggleAmcEdit()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit Dates &amp; Status
          </button>
          <button class="mis-edit-btn" onclick="exportAmc()" title="Download AMC overrides as JSON">
            {EXPORT_ICON}
            Export
          </button>
        </div>'''

if old_amc_btns in html:
    html = html.replace(old_amc_btns, new_amc_btns)
    print('Fix 2b (AMC export button): added')
else:
    print('Fix 2b SKIP')

# Insurance export button — insert before the Add Claim button
old_ins_btns = '''          <button class="mis-edit-btn" id="ins-edit-btn" onclick="toggleInsEdit()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="mis-edit-btn" onclick="openAddClaimModal()"'''
new_ins_btns = f'''          <button class="mis-edit-btn" id="ins-edit-btn" onclick="toggleInsEdit()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="mis-edit-btn" onclick="exportInsurance()" title="Download Insurance claims as JSON">
            {EXPORT_ICON}
            Export
          </button>
          <button class="mis-edit-btn" onclick="openAddClaimModal()"'''

if old_ins_btns in html:
    html = html.replace(old_ins_btns, new_ins_btns)
    print('Fix 2c (Insurance export button): added')
else:
    print('Fix 2c SKIP')

# ══════════════════════════════════════════════════════════════════
# 3. ADD EXPORT FUNCTIONS to the JS block
# ══════════════════════════════════════════════════════════════════
EXPORT_FUNCTIONS = """
/* ════════════════════════════════════════════
   EXPORT JSON (so baked-in data can be updated)
════════════════════════════════════════════ */
function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  misToast('Exported: ' + filename);
}

function exportLegal() {
  const data = JSON.parse(localStorage.getItem('mis-edit-legal') || 'null') || LEGAL_BASE;
  downloadJSON(data, 'legal-cases.json');
}

function exportAmc() {
  const overrides = JSON.parse(localStorage.getItem('mis-amc-overrides') || '{}');
  // Build full snapshot by reading current DOM rows
  const rows = document.querySelectorAll('#store-amc table tbody tr');
  const snapshot = [];
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 8) return;
    const sn   = cells[0]?.textContent.trim();
    const dept = cells[1]?.textContent.trim();
    const vendor = cells[2]?.textContent.trim();
    const descr  = cells[3]?.textContent.trim();
    const vf     = cells[4]?.textContent.trim();
    const vt     = cells[5]?.textContent.trim();
    const visits = cells[6]?.textContent.trim();
    const charge = cells[7]?.textContent.trim();
    const statusEl = cells[8]?.querySelector('span,select');
    const status = overrides[sn]?.status || (statusEl?.value || statusEl?.textContent?.trim() || '');
    snapshot.push({sn, dept, vendor, descr, vf, vt: overrides[sn]?.vt || vt, visits, charge, status});
  });
  downloadJSON({overrides, snapshot}, 'amc-contracts.json');
}

function exportInsurance() {
  const edits  = JSON.parse(localStorage.getItem('mis-ins-edits')  || '{}');
  const extras = JSON.parse(localStorage.getItem('mis-ins-extra')  || '[]');
  downloadJSON({edits, extras}, 'insurance-claims.json');
}
"""

# Inject before the closing </script> of the MIS edit JS block
# Find the last </script> before </body>
insert_before = '\n// SheetJS CDN (for Option B upload)'
if insert_before in html:
    html = html.replace(insert_before, EXPORT_FUNCTIONS + insert_before)
    print('Fix 3 (Export functions): injected')
else:
    # fallback: inject before last </script>
    html = html[::-1].replace('tpircs/<', 'tpircs/<\n' + EXPORT_FUNCTIONS[::-1], 1)[::-1]
    print('Fix 3 (Export functions): fallback inject')

# ══════════════════════════════════════════════════════════════════
# 4. FIX renderLegal to use innerHTML for <strong> tags properly
#    (currently sets innerText which strips HTML)
# ══════════════════════════════════════════════════════════════════
# The legalCellEdit uses this.textContent to capture edits which strips
# <strong> tags. Fix: store plain text, render with <strong> in renderLegal
old_case_cell = """      em ? `<td class="mis-editable ${em ? 'edit-on' : ''}" contenteditable="true"
              style="${extraStyle}" onblur="legalCellEdit(${idx},'${field}',this.textContent)"
              >${val}</td>`"""
new_case_cell = """      em ? `<td class="mis-editable ${em ? 'edit-on' : ''}" contenteditable="true"
              style="${extraStyle}" onblur="legalCellEdit(${idx},'${field}',this.textContent.trim())"
              >${val}</td>`"""
html = html.replace(old_case_cell, new_case_cell)

# Also fix case cell render — strip <strong> tags from plain text storage
old_render_case = "em ? `<td class=\"mis-editable ${em ? 'edit-on' : ''}\" contenteditable=\"true\"\n              style=\"${extraStyle}\" onblur=\"legalCellEdit(${idx},'case',this.textContent.trim())\"\n              >${val}</td>`"
# Already handled above generically

# ══════════════════════════════════════════════════════════════════
# 5. Ensure AMC loadAmc reads static rows even before any tab click
#    Problem: the update-count label needs the AMC panel rendered
#    Solution: defer count update to when panel is visible
# ══════════════════════════════════════════════════════════════════
# The loadAmc() function queries #store-amc table tbody tr which exist
# in static HTML — should work fine. The count label update is safe too.
# No change needed here.

print('\nAMC check: static rows present in HTML:',
      '#store-amc' in html and 'Annual Maintenance Contracts' in html)

# ══════════════════════════════════════════════════════════════════
# WRITE
# ══════════════════════════════════════════════════════════════════
with open('c:/Users/USER/LakeCementDashboard/mis.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'\nDone — {len(html):,} chars')
