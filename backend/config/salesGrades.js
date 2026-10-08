/*
  config/salesGrades.js — server-side mirror of forms/sales-grades.js.
  Keep both in sync (same convention as config/forms.js <-> auth.js).

  Shapes the grade-mix breakdown in the Sales dashboard aggregate
  (services/sales.js). Grade actuals come from Odoo's Sale Register feed,
  resolved by product code at sync time (odooSalesSync.js), not from manual
  entry — projections are a single daily total per officer, no grade split.
*/
const SALES_GRADES = [
  { key: 'super42',   label: 'SUPER 42',   grade: '42.5R',       color: '#F49545' },
  { key: 'max32',      label: 'MAX 32',      grade: '32.5',        color: '#239557' },
  { key: 'duramax42',  label: 'DURAMAX 42',  grade: '42.5-class',  color: '#F5C842' },
  { key: 'premiumopc', label: 'PREMIUM OPC', grade: 'CEM I',       color: '#C8C8C8' },
];

/* Odoo finished-goods product code -> Sales product line. Keyed on the
   CODE, which the Sale Register feed (2026-10-08) sends separately, rather
   than on product names: FG003 and FG005 both contain "42.5", and a
   name-substring rule once folded both into SUPER 42.

     FG001  CEMENT 42.5 R       -> SUPER 42
     FG002  CEMENT 32.5         -> MAX 32
     FG004  CEMENT OPC 42.5 N   -> PREMIUM OPC
     FG005  CEMENT B-M 42.5 N   -> DURAMAX 42 (marketing name for the plant's
                                   42.5 N B-M grade; see odooDispatchSync.js)

   FG003 (CEMENT 42.5 N) is deliberately absent: it has no Sales product
   line, and no FG003 sale appeared in the September 2026 Register. Its
   tonnage still counts toward cement totals, it just has no grade tile. */
const PRODUCT_CODE_GRADE = Object.freeze({
  FG001: 'super42',
  FG002: 'max32',
  FG004: 'premiumopc',
  FG005: 'duramax42',
});

module.exports = { SALES_GRADES, PRODUCT_CODE_GRADE };
