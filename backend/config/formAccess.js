/*
  config/formAccess.js — which roles may SUBMIT which daily-report form types.

  Single source of truth, mirrored client-side as _FORM_TYPE_ACCESS in
  auth.js — keep both in sync. Derived from the existing _IE_BTN_ROLES
  (inline sub-panel rights) and _DAILY_ACCESS (hub-page edit rights) already
  in auth.js; the 10 standalone forms/*.html pages had no server-side (or
  correct client-side) mapping at all before this.
*/
const ROLE_FORM_ACCESS = {
  production: ['production', 'quality', 'limestone', 'pile-quality'],
  pm:         ['stoppage', 'power-cons'],   /* P&M owns Stoppage & Power Cons. reports (Kiln/Cement Mill folded into Production Report) */
  logistics:  ['dispatch'],
  cpp:        ['power-plant', 'cpp'],
  mining:     ['mines'],
  stores:     ['materials'],   /* Raw Materials report is owned by Purchase & Stores */
  hr: [], it: [], md: [], admin: [], management: [], finance: [],
};

module.exports = { ROLE_FORM_ACCESS };
