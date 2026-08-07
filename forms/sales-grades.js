/* ═══════════════════════════════════════════════════════════════════
   Lake Cement Ltd — Sales product-line/grade definitions  |  sales-grades.js
   Loaded by sales.html and forms/sales-projection-form.html. Mirrored
   server-side in backend/config/salesGrades.js — keep both in sync.

   Colors/order/labels from the Nyati brand product-lines guide. Grade
   strings are the brand doc's best-known mapping; DURAMAX 42/PREMIUM OPC
   have no confirmed Odoo dispatch-label mapping yet (see sidebar/plan
   notes on Phase B — dispatch feed uses "CEMENT 42.5 N"/"CEMENT OPC
   42.5 N", unconfirmed against these two).
═══════════════════════════════════════════════════════════════════ */
'use strict';

const SALES_GRADES = [
  { key:'super42',    label:'SUPER 42',    grade:'42.5R', color:'#F49545' },
  { key:'max32',       label:'MAX 32',       grade:'32.5',  color:'#239557' },
  { key:'duramax42',   label:'DURAMAX 42',   grade:'42.5-class', color:'#F5C842' },
  { key:'premiumopc',  label:'PREMIUM OPC',  grade:'CEM I', color:'#C8C8C8' },
];
