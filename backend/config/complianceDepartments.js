/*
  config/complianceDepartments.js — who owns a compliance obligation.

  owner_role on compliance_items is a role key, because the role is the
  access boundary everywhere in this app (users.department is a display
  label nothing checks). These are the roles that can OWN obligations —
  every department role. md / management / admin read across all of them
  and own none (config/complianceAccess.js).

  SECTION_ROLE maps the workbook's own department wording onto them.
  Decided with the user 2026-10-12: the three admin-type sections
  (Corporate - Admin, Admin/Safety, Training's ISO certificates) belong to
  HR & Admin. PRODUCTION is flagged because its calibration rows name a QC
  officer as Level 1 and continue the QC list's numbering — the import
  preview lets an admin move a whole section before committing.
*/
const { ROLES } = require('./orgCatalogue');

const OWNER_ROLES = ['cpp', 'ei', 'finance', 'hr', 'it', 'logistics', 'mining', 'packing', 'pm',
  'production', 'purchase', 'quality', 'sales', 'stores'];

const ROLE_LABEL = Object.fromEntries(ROLES.map(r => [r.role, r.label]));
ROLE_LABEL.quality = ROLE_LABEL.quality || 'Quality Control (Lab)';
const roleLabel = r => ROLE_LABEL[r] || r;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/* Normalised workbook label → owner role. */
const SECTION_ROLE = {
  'corporate admin':    'hr',
  'admin safety':       'hr',
  'training':           'hr',
  'hr':                 'hr',
  'accounts finance':   'finance',
  'purchase sales':     'purchase',
  'purchase general':   'purchase',
  'purchase':           'purchase',
  'sales marketing':    'sales',
  'power plant':        'cpp',
  'mechanical':         'pm',
  'instrumentation':    'ei',
  'qc laboratory':      'quality',
  'production':         'production',
  'store':              'stores',
  'stores':             'stores',
  'logistic division':  'logistics',
  'logistics':          'logistics',
  'mining':             'mining',
};
/* Sections whose mapping is a judgement call, surfaced in the import preview. */
const AMBIGUOUS_SECTIONS = {
  'production': 'Level 1 on these calibration rows is a QC officer (Godhania) and the numbering continues the QC Laboratory list — consider Quality.',
  'purchase sales': 'Shared between Purchase and Sales.',
};

function roleForSection(label) {
  return SECTION_ROLE[norm(label)] || null;
}

/* KPI department keys (forms/access-registry.js KPI_DEPTS) that carry the
   monthly "Compliance to Legal Requirements" KPI, mapped to the owner role
   whose obligations it should reflect. The KPI key itself differs for the
   power plant (singular "requirement"). */
const KPI_DEPT_ROLE = {
  mines:      { role: 'mining', key: 'compliance-to-legal-requirements' },
  packing:    { role: 'packing', key: 'compliance-to-legal-requirements' },
  powerplant: { role: 'cpp', key: 'compliance-to-legal-requirement' },
  stores:     { role: 'stores', key: 'compliance-to-legal-requirements' },
};

module.exports = { OWNER_ROLES, roleLabel, roleForSection, normSection: norm, SECTION_ROLE, AMBIGUOUS_SECTIONS, KPI_DEPT_ROLE };
