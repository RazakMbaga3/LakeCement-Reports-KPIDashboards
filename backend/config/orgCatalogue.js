/*
  config/orgCatalogue.js — the list of roles and departments the admin UI
  offers when creating or editing a user.

  This is a PICKER, not a policy. What a role can actually do still lives in
  forms/access-registry.js (FORM_ACCESS, KPI_EDIT_DEPTS, …) and in auth.js's
  PERMISSIONS — nothing here grants anything. Its only job is to stop the
  admin screen from being a pair of free-text boxes, where a typo
  ('Production & QC' vs 'PRODUCTION & QC', or role 'mines' instead of
  'mining') would silently create an account that matches no access rule and
  therefore sees nothing, with no error anywhere to explain why.

  `role` is the access key every rule is written against and is deliberately
  a closed set. `department` is the human label shown in the UI and on
  reports; it is stored on the user row but no gate reads it, which is why
  the Quarry HOD could sit under a stale 'MINING' label for weeks without
  anything breaking. Keeping the pair together here is what makes that kind
  of drift visible.
*/

/* Ordered for the picker: oversight roles first, then departments A–Z.
   `department` is the default label suggested when this role is chosen;
   an admin can still override it (Sajiv Kumar is Purchase HOD and General
   Manager — one account, and the label is a judgement call). */
const ROLES = [
  { role: 'md',         label: 'Managing Director / Executive', department: 'CORPORATE',         oversight: true },
  { role: 'management', label: 'Senior Management',             department: 'CORPORATE',         oversight: true },
  { role: 'admin',      label: 'System Administrator',          department: 'IT',                oversight: true },
  { role: 'cpp',        label: 'Power Plant',                   department: 'POWER PLANT' },
  { role: 'ei',         label: 'E & I',                         department: 'E & I' },
  { role: 'finance',    label: 'Finance & Accounts',            department: 'FINANCE' },
  { role: 'hr',         label: 'HR & Admin',                    department: 'HR & ADMIN' },
  { role: 'it',         label: 'IT',                            department: 'IT' },
  { role: 'logistics',  label: 'Logistics & Workshops',         department: 'LOGISTICS' },
  { role: 'mining',     label: 'Quarry',                        department: 'QUARRY' },
  { role: 'packing',    label: 'Packing Plant',                 department: 'PACKING' },
  { role: 'pm',         label: 'Projects & Maintenance',        department: 'P & M' },
  { role: 'production', label: 'Production & QC',               department: 'PRODUCTION & QC' },
  { role: 'purchase',   label: 'Purchase / Procurement',        department: 'PURCHASE' },
  /* QC Manager and lab officers (DEC-005). Was missing here, so the role
     existed only through db/seed.js and admin-users.html could not assign
     it — the API 400'd it as unknown. */
  { role: 'quality',    label: 'Quality Control (Lab)',         department: 'PRODUCTION & QC' },
  { role: 'sales',      label: 'Sales & Marketing',             department: 'SALES & MARKETING' },
  { role: 'stores',     label: 'Stores',                        department: 'STORES' },
];

/* L1/L2/L3 as the business says them, mapped to the `level` column's values.
   Order matters — the UI lists them most-senior first. */
const LEVELS = [
  { level: 'hod',     code: 'L1', label: 'HOD / Head of Department',
    note: 'Edits and submits monthly KPIs; approves the department\'s daily reports.' },
  { level: 'senior',  code: 'L2', label: 'Senior Officer / Supervisor',
    note: 'Fills and submits daily reports for HOD approval. No KPI editing.' },
  { level: 'officer', code: 'L3', label: 'Officer / Operator',
    note: 'Fills and submits daily reports for HOD approval. No KPI editing.' },
];

/* Labels that exist on real user rows but are not a role's home department:
   AUTOMATION holds the two import service accounts, OPERATIONS holds the
   Plant Head (role 'md', but not Corporate). Offered so editing one of
   those accounts does not silently relabel it. */
const EXTRA_DEPARTMENTS = ['AUTOMATION', 'OPERATIONS'];

const ROLE_KEYS  = ROLES.map(r => r.role);
const LEVEL_KEYS = LEVELS.map(l => l.level);
const DEPARTMENTS = [...new Set([...ROLES.map(r => r.department), ...EXTRA_DEPARTMENTS])].sort();

module.exports = { ROLES, LEVELS, DEPARTMENTS, ROLE_KEYS, LEVEL_KEYS };
