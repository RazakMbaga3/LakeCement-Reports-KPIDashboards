/*
  test/fixtures/compliance-workbook.js — a synthetic "Compliance Master"
  workbook for tests and CI.

  The real workbook stays out of the repository (the web root is the git
  checkout — RAID I-42), so CI builds this stand-in instead. It reproduces
  the real file's layout and every quirk the importer handles, row for row
  where it matters:
    • visible "Compliance Master - Operations" + "Compliance Matser - Mining"
      (sic), plus a hidden draft sheet that must be ignored;
    • dates as dd.mm.yyyy text AND as Date cells; a "year typed into a date
      cell" pair (the 1905 dates); "End of Project"; a row shifted one
      column right; agency/description swapped;
    • recurring rules in the To column ("20th every month", "07th Every
      Quarter", "30th Every Quarter"); a bundle parent with child rows;
    • Mining blocks with day/month-swapped Date cells, Complied / Not
      complied / Partially complied statuses, fees, conditions.
  EXPECTED holds what the importer must make of it.
*/
const ExcelJS = require('exceljs');

const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day));

const OPS_ROWS = [
  // [sr, dept, agency, desc, custodian, freq, l1, l2, from, to, orig, current, status, lead1, lead2, lead3, remarks]
  [1, 'Corporate - Admin', 'Temeke Municipal Council', 'Building Permit Plot No 265 Kimbiji', 'HO', 'One time', null, 'Sajivkumar PS', null, null, null, null, 'Inactive', null, null, null, 'Boundary Wall'],
  [2, 'Corporate - Admin', 'Brela', 'License - Business License - HO, Ilala', 'HO', 'Yearly', 'Marina', 'Sajivkumar PS', '02.12.2025', '17.12.2026', null, null, 'Active', '45DAYS', '30DAYS', '20DAYS', null],
  [3, 'Corporate - Admin', 'Ministry Of Labour & Employment - Osha', 'OSHA - Compliance License -HO', 'HO', 'Yearly', 'Marina', 'Sajivkumar PS', '02.01.2025', '01.01.2026', null, null, 'Active', '45DAYS', '30DAYS', '20DAYS', null],
  [4, 'Corporate - Admin', 'FIRE SAFETY CERTIFICATE - HO', 'Fire & Rescue ', 'HO', 'Yearly', 'Marina', 'Sajivkumar PS', '07.01.2025', '06.01.2026', null, null, 'Active', null, null, null, null],
  null,
  [1, 'Purchase / General', 'EWURA', 'Petroleum (Lubricants Wholesale Business License)', 'HO', '5 years', 'Marina', 'Sajivkumar PS', d(1905, 7, 11), d(1905, 7, 16), 'Yes', 'Yes', 'Active', '90 days', '60 days', '45 days', null],
  null,
  [1, 'MECHANICAL', 'OSHA', 'OVER HEAD CRANE :SWL-10 TON ', 'Factory', 'Yearly', 'Rawat', 'Pavan Gandhi', d(2024, 5, 27), d(2027, 5, 27), '√', '√', 'Active', '45DAYS', '30DAYS', '20DAYS', 'Under renewal, Inspection done'],
  [2, 'MECHANICAL', 'OSHA', 'OVER HEAD CRANE :SWL-10 TON ', 'Factory', 'Yearly', 'Rawat', 'Pavan Gandhi', '27.05.2024', '27.05.2025', '√', '√', 'Active', '45DAYS', '30DAYS', '20DAYS', 'Under renewal, Inspection done'],
  [3, 'MECHANICAL', 'OSHA', 'WIRE ROPES, 10PCS (5TONS TO 30TONS RANGE)', 'Factory', 'Yearly', 'Rawat', 'Pavan Gandhi', '27.05.2024', '27.05.2025', '√', '√', 'Active', '45DAYS', '30DAYS', '20DAYS', null],
  [4, 'MECHANICAL', 'OSHA', 'SHACKLES ,15PCS (1TON TO 10 TONS RANGE)', 'Factory', 'Yearly', 'Rawat', 'Pavan Gandhi', '27.05.2024', '27.05.2025', '√', '√', 'Active', '45DAYS', '30DAYS', '20DAYS', null],
  [5, 'MECHANICAL', 'OSHA', 'HYDRA 12 TON ,S/N :ECE01193KL0193322', 'Factory', 'Yearly', 'Rawat', 'Pavan Gandhi', '27.05.2024', '27.05.2025', '√', '√', 'Active', '45DAYS', '30DAYS', '20DAYS', null],
  null,
  [1, 'Admin/Safety', 'Minister of State', 'Environmental Impact Assessment Certificate', 'Factory', 'Once per project lifetime', 'Sophia', 'Pavan Gandhi', '13.01.2010', 'End of Project', null, null, 'Valid', null, null, null, null],
  null,
  [1, 'Training', 'ACM', 'Integrated Management System Certificates', 'Factory', 'Yearly', 'Silvia', 'Pavan Gandhi', null, null, null, null, 'Active', '45DAYS', '30DAYS', '20DAYS', null],
  [null, null, null, 'ISO 9001:2015 Certificate', null, null, null, null, '16.01.2023', '15.01.2026', null, null, 'Active', null, null, null, null],
  [null, null, null, 'ISO 14001 / ISO 45000 Certificates', null, null, null, null, '29.05.2026', '28.05.2028', null, null, 'Active', null, null, null, null],
  null,
  [1, 'Accounts / Finance', 'Tanzania Revenue Authority', 'VAT PAYMENT & RETURN', 'HO', 'Monthly', 'Rahul', 'Sankalp', null, '20th every month', 'Available', 'Available', 'Available', '7DAYS', '5DAYS', '2DAYS', null],
  [2, 'Accounts / Finance', 'Kigamboni Municipal Council', 'City Service Levy PAYMENT & RETURN', 'Factory', 'Quarterly', 'Muneesh/ Rahul', 'Sankalp', null, '07th Every Quarter', 'Available', 'Available', 'Available', '20DAYS', '10DAYS', '5DAYS', null],
  [3, 'Accounts / Finance', 'Tanzania Revenue Authority', 'Corporate Tax - Advance Tax', 'HO', 'Quarterly', null, 'Sankalp', null, '30th Every Quarter', 'Available', 'Available', 'Available', '20DAYS', '10DAYS', '5DAYS', null],
  [4, 'Accounts / Finance', 'Mining Commission', 'Annual Rent-For payments only', 'HO', 'Yearly', 'Punit', 'Sankalp', null, 'Yearly', 'Available', 'Available', 'Available', '45DAYS', '30DAYS', '20DAYS', null],
  [5, 'Accounts / Finance', 'Tanzania Revenue Authority', 'TRA - TIN CERTIFICATE, KIMBIJI, TEMEKE', 'HO', 'FIXED', 'Punit', 'Sankalp', 'One Time', '09.06.2006', null, null, null, 'Active', null, null, 'Temeke'],
];

const MIN_ROWS = [
  // [B block, C desc, D freq, E status, F due, G L1, H L2]
  [null, 'LAKE CEMENT LIMITED'],
  [],
  [null, 'MINING COMPLIANCE MASTER'],
  [],
  [1, 'License No.', 'ML 395/10', null, 'Resource', 'Limestone'],
  [null, 'Location', 'Kimbiji, Kigamboni', null, 'Sq.Km', 8.0847],
  [null, 'License Type ', 'ML - Industrial Minerals '],
  [null, null, 'Frequency', 'Status ', 'Due Next ', 'Responsibility L1', 'Responsibility L2'],
  [null, 'Mining Lease (Date of Issue - 24/05/10)', 'Every 10 Years ', 'Active', d(2030, 5, 23), 'PSS Sajiv', 'PSS Sajiv'],
  [null, 'Rent @ US $12,320', 'Annual', 'Complied', '24/05/2026', 'PSS Sajiv', 'PSS Sajiv'],
  [null, 'Mining Royalty Returns ', 'Annual (before 15th Jan)', 'Complied', d(2026, 1, 15), 'Mukesh Agrawal', 'Pavan Gandhi'],
  [null, 'Submission of CSR Plan (before July) ', 'Annual (before July)', 'Complied', d(2026, 1, 7), 'Mukesh Agrawal', 'Pavan Gandhi'],
  [1],
  [null, 'Monthly mining royalty returns in prescribed format', 'Monthly (before 4th)', 'Complied', d(2025, 4, 12), 'Mukesh Agrawal', 'Pavan Gandhi'],
  [null, 'Display of Safety Signage at key locations', 'Continuous', 'Complied', 'To be reviewed periodically', 'Mukesh Agrawal', 'Pavan Gandhi'],
  [null, 'Note '],
  [null, 'Payment of Ushuru for transport of sand', 'As & when required', 'Complied', 'As & when required', 'Pavan Gandhi', 'Pavan Gandhi'],
  [],
  [2, 'License No.', 'ML 552/15', null, 'Resource', 'Limestone'],
  [null, 'Location', 'Tarawanda, Bagamoyo', null, 'Sq.Km', 5.06],
  [null, 'License Type ', 'ML - Industrial Minerals '],
  [null, null, 'Frequency', 'Status ', 'Due Next ', 'Responsibility L1', 'Responsibility L2'],
  [null, 'Mining Lease (Date of Issue - 30/09/15)', 'Every 10 Years ', 'Active', '30/09/2025', 'PSS Sajiv', 'PSS Sajiv'],
  [null, 'Mining Plan Compliance Report (before 30th Jan)', 'Annual (before 30th Jan)', 'Not complied', d(2026, 1, 30), 'Mukesh Agrawal', 'Pavan Gandhi'],
  [null, 'Submission of compensation plan to MC', 'One-time, Review Every 3 yrs', 'Partially complied', null, 'Mukesh Agrawal', 'Pavan Gandhi'],
  [null, 'Maintain a distance of minimum 200 meters from public buildings', 'Continuous', 'Not complied', 'To be reviewed periodically', 'Mukesh Agrawal', 'Pavan Gandhi'],
];

async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  const draft = wb.addWorksheet('HO');
  draft.state = 'hidden';
  draft.addRow(['', '', 'LAKE CEMENT LIMITED']);
  draft.addRow(['', 'Mining', 'should never be read']);

  const ops = wb.addWorksheet('Compliance Master - Operations');
  ops.addRow(['LAKE CEMENT LIMITED']);
  ops.addRow(['COMPLIANCE MASTER']);
  ops.addRow(['Sr. No.', 'Department', 'Agency / Institution / Govt Body', 'Description / Details', 'Custodian', 'Frequency',
    'Responsibility', null, 'VALIDITY', null, 'Document Upload / Attach', null, 'Status', 'Shoot Auto Mailer Prior Renewal Date']);
  ops.addRow([null, null, null, null, null, null, 'Level 1', 'Level 2', 'FROM ', 'TO', 'Original', 'Current', null, 'Direct', '2nd Level', 'Head', 'REMARKS']);
  for (const r of OPS_ROWS) ops.addRow(r || []);

  const min = wb.addWorksheet('Compliance Matser - Mining');
  for (const r of MIN_ROWS) min.addRow(r.length ? [null, ...r] : []);
  return wb.xlsx.writeBuffer().then(b => Buffer.from(b));
}

/* What the importer must make of it (as of TODAY). */
const TODAY = '2026-10-12';
const EXPECTED = {
  operationsItems: 18,          // 16 rows + 2 bundle children (the bundle parent is a group header)
  miningItems: 11,
  groups: 3,                    // IMS bundle + 2 mining licences
  operationsNonBlank: 19,
  miningNonBlank: 23,
};

module.exports = { buildWorkbook, EXPECTED, TODAY };
