/*
  config/salesGrades.js — server-side mirror of forms/sales-grades.js.
  Keep both in sync (same convention as config/forms.js <-> auth.js).

  Used to shape the grade-mix breakdown in the Sales dashboard aggregate
  once Odoo sale.order/account.move data is wired up (see
  services/salesOdoo.js) — grade actuals come from Odoo, not manual entry
  (Projections are a single daily total per officer, no grade split).
*/
const SALES_GRADES = [
  { key: 'super42',   label: 'SUPER 42',   grade: '42.5R',       color: '#F49545' },
  { key: 'max32',      label: 'MAX 32',      grade: '32.5',        color: '#239557' },
  { key: 'duramax42',  label: 'DURAMAX 42',  grade: '42.5-class',  color: '#F5C842' },
  { key: 'premiumopc', label: 'PREMIUM OPC', grade: 'CEM I',       color: '#C8C8C8' },
];

module.exports = { SALES_GRADES };
