/*
  services/itAssetImport.js — parses IT's monthly "M - 19 IT Report" Excel
  workbook into the ten it_assets categories (see
  db/migrations/028_it_assets.sql).

  WHY A HEADER SCAN, NOT HARDCODED ROW NUMBERS: two of the ten sheets carry
  a title row above their real header ("DCS Licenses" has a title with an
  embedded "Date : dd.mm.yyyy"; "E-WASTE & SCRAP" has a title AND a
  sub-title row before its header), and the workbook is hand-maintained —
  a stray blank row inserted next month would silently shift every
  following sheet's data up or down one row if this just read "row 3".
  CATEGORIES below instead says what each header ROW LOOKS LIKE (its first
  few expected cell values) and findHeaderRow() scans the first several
  rows of the sheet for the best match. If IT's next export shifts a
  header by a row, this keeps working; if a sheet no longer resembles what
  it used to at all, the category is reported missing rather than parsed
  into garbage.

  WHY EXCELJS, NOT THE `xlsx` PACKAGE: exceljs is already a dependency
  (services/misExcel.js, routes/quarry.js's sibling code); adding a second
  Excel library for one more import doubles the attack surface and the
  version-drift risk for no benefit.

  'NULL' AS TEXT: several sheets have literal blank cells but a few rows
  have the string "NULL" typed in by hand (Factory Computer Master List
  row 5's Monitor/Keyboard/Mouse columns, for one) — a human's way of
  saying "not applicable", not a value. normalizeCell() turns both empty
  strings and the literal 'NULL'/'null' text into real SQL NULL, so a
  search or an export doesn't have to special-case the string.

  SHEETS ARE NOT CLEAN SINGLE TABLES — verified against the real sample
  workbook, not assumed from a description of it. Several sheets have a
  second (or third, or fifth) register GLUED onto the bottom or middle of
  the same sheet, reusing some of the same-looking column labels:
  "Factory Computer Master List" ends with Server / UPS / "Digital Board,
  Television & Projector" / Scanner sub-tables after its real computer
  list; "HO Computer List" ends with Network Switches/Firewall / UPS /
  Cameras-WiFi / Digital Board sub-tables. isStructuralRow() +
  headerMatchFraction() (below) exist entirely to find that boundary and
  stop before it, rather than filing a scanner or a UPS as a "computer".
  Other sheets glue together sub-groups that ARE the same register in
  substance (CCTV's per-NVR camera groups; E-WASTE's Desktop/Monitor/
  Printers groups, all S/N+Model+Serial+Remarks) — those are correctly
  kept as one category. See each function's comment for how the two
  cases are told apart, and CATEGORIES.biometric_devices's comment below
  for the one sheet ("Biometric-RFID-Photosensors") where the glued-on
  sub-tables are deliberately LEFT OUT rather than forced to fit.
*/

const ExcelJS = require('exceljs');

/* ── Category definitions ─────────────────────────────────────────────
   `sheetNames` — every sheet name this category might appear under.
   Sheet names are matched by TRIMMED, case-insensitive comparison so a
   trailing space some sheet names carry in the source ("CCTV ") or a
   casing change next month doesn't break the match — but the header
   text itself is stored/keyed EXACTLY as seen, per the task's own
   instruction not to over-normalize real column labels.

   `headerScan` — the ordered list of column keys this category's header
   row must resemble. `columns[i].label` is compared case-insensitively,
   trimmed, against each candidate row's cells; a row matching most of
   the labels (at least MIN_HEADER_MATCH of them, in the right relative
   order) is taken as the header row.

   `columns[i].key` is the JSONB key the value is stored under — a
   normalized form of the source column label (lowercase, underscored),
   so the same physical field reads the same way whatever the exact
   capitalization IT used this month. */
const MIN_HEADER_MATCH_FRACTION = 0.7;
const HEADER_SCAN_ROWS = 6; // scan the first N rows for the header

const CATEGORIES = {
  factory_computers: {
    label: 'Factory Computer Master List',
    sheetNames: ['Factory Computer Master List'],
    columns: [
      { key: 'sr_no',           label: 'Sr No' },
      { key: 'name',            label: 'Name' },
      { key: 'user',            label: 'User' },
      { key: 'department',      label: 'Department' },
      { key: 'processor_ram',   label: 'Processor & RAM' },
      { key: 'serial_number',   label: 'Serial Number' },
      { key: 'model',           label: 'Model' },
      { key: 'os',              label: 'OS' },
      { key: 'sophos',          label: 'Sophos' },
      { key: 'mac_address',     label: 'Mac address' },
      { key: 'ip_address',      label: 'IP address' },
      { key: 'monitor_model',   label: 'Monitor Model' },
      { key: 'monitor_sn',      label: 'Monitor SN' },
      { key: 'keyboard_model',  label: 'Keyboard Model' },
      { key: 'keyboard_sn',     label: 'Keyboard SN' },
      { key: 'mouse_model',     label: 'Mouse Model' },
      { key: 'mouse_sn',        label: 'Mouse SN' },
    ],
    // The source header row only names these last six "Model"/"SN" four
    // times over (Monitor/Keyboard/Mouse groups come from the row ABOVE
    // the header — see the sample workbook's row 2 sub-headers), so the
    // scan matches on the first 11 columns (which are unambiguous) and
    // this list supplies the disambiguated labels for storage.
    matchColumns: 11,
  },
  ho_computers: {
    label: 'HO Computer List',
    sheetNames: ['HO Computer List'],
    columns: [
      { key: 'sr_no',           label: 'Sr No' },
      { key: 'name',            label: 'Name' },
      { key: 'user',            label: 'User' },
      { key: 'department',      label: 'Department' },
      { key: 'ram',             label: 'RAM' },
      { key: 'processor',       label: 'Processor' },
      { key: 'serial_number',   label: 'Serial Number' },
      { key: 'model',           label: 'Model' },
      { key: 'os',              label: 'OS' },
      { key: 'sophos',          label: 'Sophos' },
      { key: 'mac_address',     label: 'Mac address' },
      { key: 'ip_address',      label: 'IP address' },
      { key: 'monitor_model',   label: 'Monitor Model' },
      { key: 'monitor_sn',      label: 'Monitor SN' },
      { key: 'keyboard_model',  label: 'Keyboard Model' },
      { key: 'keyboard_sn',     label: 'Keyboard SN' },
      { key: 'mouse_model',     label: 'Mouse Model' },
      { key: 'mouse_sn',        label: 'Mouse SN' },
    ],
    matchColumns: 12,
  },
  printers: {
    label: 'Printers',
    sheetNames: ['Printers- Plant-HO', 'Printers-Plant-HO', 'Printers - Plant-HO'],
    columns: [
      { key: 'sr_no',       label: 'Sr No' },
      { key: 'location',    label: 'Location' },
      { key: 'dept_user',   label: 'Department/User' },
      { key: 'model',       label: 'Model' },
      { key: 'serial_number', label: 'Serial Number' },
      { key: 'toner',       label: 'Toner' },
      { key: 'status',      label: 'STATUS' },
    ],
  },
  equipment_software: {
    label: 'Equipment Software',
    sheetNames: ['Equipment Software'],
    columns: [
      { key: 'sl_no',            label: 'Sl No' },
      { key: 'location',         label: 'Location' },
      { key: 'equipment_name',   label: 'Equipment Name' },
      { key: 'software_details', label: 'Software Details' },
      { key: 'backup',           label: 'Backup' },
      { key: 'frequency',        label: 'Frequency' },
      { key: 'responsibility',   label: 'Responsibility' },
    ],
  },
  dcs_licenses: {
    label: 'DCS Licenses',
    sheetNames: ['DCS Licenses'],
    columns: [
      { key: 'sl_no',              label: 'SL No' },
      { key: 'description',        label: 'Description' }, // source misspells "Descreption" — stored key is the corrected, meaningful one
      { key: 'order_no',           label: 'Order No' },
      { key: 'license_serial_no',  label: 'License Serial No' },
      { key: 'dispatch_note_no',   label: 'Dispatch Note No' },
      { key: 'license_no',         label: 'License No' },
      { key: 'type_of_software',   label: 'Type Of Software' },
      { key: 'type_of_use',        label: 'Type Of Use' },
      { key: 'type_of_license',    label: 'Type of License' },
      // Column J duplicates column I's "Type of License" verbatim in every
      // row of the sample (a merged-cell artifact) — intentionally not
      // stored a second time.
    ],
    matchColumns: 9,
  },
  network_switches: {
    label: 'Network Switches / Firewall',
    sheetNames: ['Network Switches-Firewall', 'Network Switches - Firewall'],
    columns: [
      { key: 'sn',           label: 'S/N' },
      { key: 'make',         label: 'Make' },
      { key: 'location',     label: 'Location' },
      { key: 'model_no',     label: 'Model No' },
      { key: 'serial_no',    label: 'Serial No' },
      { key: 'ports',        label: 'Ports' },
      { key: 'fiber_ports',  label: 'Fiber Ports' },
    ],
  },
  cctv: {
    label: 'CCTV',
    sheetNames: ['CCTV', 'CCTV '], // source sheet name carries a trailing space
    columns: [
      { key: 'sn',          label: 'S/NO' },
      { key: 'camera_name', label: 'Camera Name' },
      { key: 'ip_address',  label: 'IP Address' },
      { key: 'model_no',    label: 'Model No' },
      { key: 'serial_no',   label: 'Serial No' },
      { key: 'status',      label: 'Status' },
    ],
  },
  external_hard_disks: {
    label: 'External Hard Disks',
    sheetNames: ['External Hard Disk', 'External Hard Disks'],
    columns: [
      { key: 'sr_no',       label: 'Sr.NO' },
      { key: 'name',        label: 'Name' },
      { key: 'dept',        label: 'Dept' },
      { key: 'qty',         label: 'Qty' },
      { key: 'capacity',    label: 'Capacity' },
      { key: 'actual_data', label: 'Actual Data' },
    ],
  },
  /* SCOPE NOTE, checked against the real sheet, not just its name: the
     "Biometric-RFID-Photosensors" sheet is really the Biometric
     Controllers table (this shape — S/N, Location, IP, MAC, Serial,
     Model) followed by three MORE sub-tables glued below it — "RFID
     Readers", "Truck Movement Photo Sensors", "UMS Controllers" — each
     only two or three columns wide (S/N, Location, and either IP Address
     or "Location on WB"), with no MAC address, serial number or model at
     all. They fail this category's own header match badly enough that
     the parser correctly stops before them (see isStructuralRow /
     headerMatchFraction), which was verified against this exact
     workbook — this is a deliberate scope decision, not an accident: an
     "asset register" needs something to identify the physical unit by
     (a serial, a model), which these access-control readers' rows simply
     don't carry in this export. Bringing them in would mean inventing a
     fourth, much sparser category for a device family IT's own report
     doesn't itemize the same way. Left for a future migration if IT ever
     wants RFID readers/photosensors tracked as their own register. */
  biometric_devices: {
    label: 'Biometric Controllers',
    sheetNames: ['Biometric-RFID-Photosensors', 'Biometric - RFID - Photosensors'],
    columns: [
      { key: 'sn',           label: 'S/N' },
      { key: 'location',     label: 'Location' },
      { key: 'ip_address',   label: 'IP Address' },
      { key: 'mac_address',  label: 'MAC Address' },
      { key: 'serial_no',    label: 'Serial No' },
      { key: 'model_no',     label: 'Model No' },
    ],
  },
  ewaste: {
    label: 'E-Waste & Scrap',
    sheetNames: ['E-WASTE & SCRAP', 'E-Waste & Scrap'],
    columns: [
      { key: 'sn',              label: 'S/N' },
      { key: 'model',           label: 'Model' },
      { key: 'serial_number',   label: 'Serial Number' },
      { key: 'remarks',         label: 'Remarks' },
    ],
  },
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

/* ── Cell/text helpers ─────────────────────────────────────────────── */

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(t => t.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return cellText(value.result);
    if (value instanceof Date) return value.toISOString();
    return '';
  }
  return String(value);
}

/* '', 'NULL', 'null', 'Null' (with or without surrounding whitespace) all
   mean "no value" in this workbook — a human typed NULL as a placeholder
   in several rows/columns. Real SQL NULL is what should land in the DB;
   storing the literal string would make every downstream search and
   export treat "NULL" as if it were data. */
function normalizeCell(raw) {
  const t = cellText(raw).trim();
  if (t === '' || /^null$/i.test(t)) return null;
  return t;
}

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/* Finds the sheet in `workbook` matching one of `sheetNames`, trimmed and
   case-insensitively — so "CCTV " in the source matches "CCTV" here and a
   future export that drops/adds the trailing space still matches. */
function findSheet(workbook, sheetNames) {
  const wanted = sheetNames.map(norm);
  return workbook.worksheets.find(ws => wanted.includes(norm(ws.name))) || null;
}

/* Scans the first HEADER_SCAN_ROWS rows of `sheet` for the row that best
   matches `columns[0..matchColumns-1].label`, comparing trimmed,
   case-insensitive text in the SAME column position the sample workbook
   uses. Returns the 1-based row number, or null if no row reaches
   MIN_HEADER_MATCH_FRACTION. */
function findHeaderRow(sheet, columns, matchColumns) {
  const want = columns.slice(0, matchColumns).map(c => norm(c.label));
  const need = Math.ceil(want.length * MIN_HEADER_MATCH_FRACTION);

  let best = { row: null, score: -1 };
  for (let r = 1; r <= HEADER_SCAN_ROWS; r++) {
    const row = sheet.getRow(r);
    let score = 0;
    for (let i = 0; i < want.length; i++) {
      const cellVal = norm(cellText(row.getCell(i + 1).value));
      if (cellVal && cellVal === want[i]) score++;
    }
    if (score > best.score) best = { row: r, score };
  }
  return best.score >= need ? best.row : null;
}

/* True when `row`'s first cell (the register's own ordinal/Sr-No column)
   is NOT what an ordinary data row puts there. Checked across every real
   data row of all ten sheets: the ordinal column is always a small integer,
   blank, or (CCTV's NVR unit line) the literal "&gt;&gt;" — never a word.
   So a non-numeric, non-blank, non-"&gt;&gt;" first cell reliably marks a
   STRUCTURAL row: a section title smeared across the row (Factory Computer
   Master List row 136, "Server" repeated across all 17 cells), or a
   restated header row ("Sr No | Name | …"). headerMatchFraction() below is
   what then decides whether a structural row means "keep going, same
   register" or "stop, a different register begins here".

   A BLANK ordinal cell needs a second check: some genuine data rows leave
   it blank (CCTV rows 113-116 are more real cameras with no Sr No filled
   in, each with 5 populated cells that are mostly-to-entirely DISTINCT
   values — even the sparsest, row 115's "-,-,-" placeholders, is 3
   distinct out of 5) while some structural rows also leave it blank
   because the title starts one cell in (Factory Computer Master List row
   137: "Server Workstation Hardware" repeated across columns 2-11, then
   "Monitor"/"Keyboard"/"Mouse" reused across 12-17 — only 4 distinct
   values spread over 16 populated cells). A blank-ordinal row is treated
   as structural when its populated cells are LOW-CARDINALITY — few
   distinct values repeated across many cells, the shape a title or a
   grouped sub-header takes and a real row never does, since a real row's
   fields differ from column to column. 0.4 sits well clear of both
   measured extremes above (real data's worst case 0.6 vs junk's 0.25). */
const LOW_CARDINALITY_THRESHOLD = 0.4;
function isStructuralRow(row, checkCols) {
  const first = norm(cellText(row.getCell(1).value));
  if (first) return !/^\d+$/.test(first) && first !== '>>';

  const vals = [];
  for (let c = 2; c <= checkCols; c++) {
    const t = norm(cellText(row.getCell(c).value));
    if (t) vals.push(t);
  }
  if (vals.length < 2) return false;
  return (new Set(vals).size / vals.length) <= LOW_CARDINALITY_THRESHOLD;
}

/* What fraction of `columns`' labels does `row` repeat, position for
   position? Used to tell a genuine restatement of THIS category's own
   header (CCTV repeats "S/NO | Camera Name | IP Address | Model No |
   Serial No | ..." after every NVR sub-heading — keep going, same
   register) from a DIFFERENT register's header that merely reuses a few
   generic words like "Sr No"/"Model"/"Serial Number" (HO Computer's
   "Network Switches/Firewall" sub-table reads "Sr No | Name | Model |
   Serial No" — 2 of the computer list's 10 header words in the same
   positions, nowhere near a real match — stop here, this is not more
   computers).

   NOTE (an honest, accepted tradeoff): Factory Computer Master List's
   trailing "Server / Server Workstation Hardware" section reuses the
   SAME 17-column template (it scores ~90% here) and so is NOT excluded —
   it merges into factory_computers as more computer-shaped rows. The
   workbook's own author cloned the computer-list template for servers,
   which makes it structurally indistinguishable from more computers by
   any header-shape rule; UPS/Digital-Board/Scanner/Network-Switch/
   Cameras-WiFi sections that follow score far lower (see the sample
   scores captured while building this parser: 20% or less) and DO stop
   the parse, which is the case that actually matters (a printer or a
   scanner must never be filed as a computer). */
function headerMatchFraction(row, columns) {
  let matches = 0, total = 0;
  for (let i = 0; i < columns.length; i++) {
    const want = norm(columns[i].label);
    if (!want) continue;
    total++;
    if (norm(cellText(row.getCell(i + 1).value)) === want) matches++;
  }
  return total ? matches / total : 0;
}
const REHEADER_SAME_CATEGORY_THRESHOLD = 0.7;

/* Parses one category's sheet into an array of row objects, stopping
   BEFORE a foreign register glued onto the bottom/middle of the same
   sheet (see isStructuralRow/headerMatchFraction above — this is why
   Factory Computer Master List yields computers [+ the servers tradeoff
   noted above], not computers plus UPS/digital-boards/scanners smashed
   into the same shape).

   `columns` drives both which spreadsheet column feeds which JSONB key
   and how many columns are read per row (columns.length, NOT the sheet's
   reported column count — several sheets report a bogus huge dimensions
   string from old merged/styled cells far past where any data actually
   is). */
function parseCategory(sheet, columns, matchColumns) {
  const headerRow = findHeaderRow(sheet, columns, matchColumns || columns.length);
  if (!headerRow) return { rows: null, reason: 'header row not found (sheet present but unrecognized)' };

  const rows = [];
  // sheet.rowCount (the sheet dimension's last row), NOT actualRowCount —
  // exceljs's "actual" count undercounts a sheet that has a real data row
  // sitting after a fully-blank gap (CCTV's rows 111-112 are blank before
  // four more real camera rows at 113-116; actualRowCount stopped at 110
  // and silently dropped them).
  const lastRow = sheet.rowCount;
  for (let r = headerRow + 1; r <= lastRow; r++) {
    const row = sheet.getRow(r);

    if (isStructuralRow(row, columns.length)) {
      const fraction = headerMatchFraction(row, columns);
      if (fraction >= REHEADER_SAME_CATEGORY_THRESHOLD) continue; // restated header — same register, skip just this row
      if (fraction > 0) break;                                    // a different register's header — stop, don't consume it
      continue; // a title/sub-heading row with no header-shaped content at all (e.g. "Server" / "DCS Systems") — skip it
    }

    const obj = {};
    let hasAny = false;
    for (let i = 0; i < columns.length; i++) {
      const v = normalizeCell(row.getCell(i + 1).value);
      obj[columns[i].key] = v;
      if (v !== null) hasAny = true;
    }
    if (hasAny) rows.push(obj);
  }
  return { rows, reason: null };
}

/* ── Public entry point ───────────────────────────────────────────────
   parseWorkbook(buffer) -> {
     categories: { [categoryKey]: { rows: [...], label, sheetName } },
     missing:    [{ category, label, reason }],   // sheet absent or unrecognized
     anyFound:   boolean,
   }

   A category absent from the upload is reported in `missing` and simply
   omitted from `categories` — the caller (routes/itAssets.js) must NOT
   invent an empty replacement for it; a workbook missing one sheet must
   not wipe that category's existing rows. `anyFound` lets the caller
   reject a workbook where NOT ONE expected sheet was found at all (the
   wrong file entirely) with one clear error, rather than a report saying
   "10 categories missing" that reads like the workbook is merely
   incomplete. */
async function parseWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const categories = {};
  const missing = [];

  for (const key of CATEGORY_KEYS) {
    const def = CATEGORIES[key];
    const sheet = findSheet(workbook, def.sheetNames);
    if (!sheet) {
      missing.push({ category: key, label: def.label, reason: 'sheet not found in workbook' });
      continue;
    }
    const { rows, reason } = parseCategory(sheet, def.columns, def.matchColumns);
    if (rows === null) {
      missing.push({ category: key, label: def.label, reason });
      continue;
    }
    categories[key] = { rows, label: def.label, sheetName: sheet.name };
  }

  return { categories, missing, anyFound: Object.keys(categories).length > 0 };
}

module.exports = { parseWorkbook, CATEGORIES, CATEGORY_KEYS };
