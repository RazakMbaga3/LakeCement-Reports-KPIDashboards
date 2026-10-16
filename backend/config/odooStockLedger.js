/*
  config/odooStockLedger.js — which Production Report stock ledgers are rolled
  forward from Odoo, from which Odoo flows, and why each one is (or is not)
  trusted. Read by services/odooStockLedger.js.

  ── What a "ledger" is here ─────────────────────────────────────────────
  The plant's Production Report keeps one stock ledger per material:

      closing = opening + received − consumed,   opening(D) = closing(D−1)

  Measured on the 2026-04-01..06-30 Excel seed (daily_reports, 90 day-pairs):
  open(D) == close(D−1) on 90/90 pairs for limestone, crusher pile, clay,
  iron ore, ID clay, own clinker, purchased clinker, gypsum, Starex, grinding
  aid and coal mill — a pure roll-forward, nothing typed in between. Coal is
  the exception (see COAL below). The cement per-grade silo rows
  (cm1_*_open …) are NOT continuous (cm1_425r breaks on 79/90 pairs) and the
  RM1 raw-meal silo is not either, so neither is listed here: their openings
  are re-typed by the plant every day and stay manual.

  ── Anchor ──────────────────────────────────────────────────────────────
  The roll starts from the plant's OWN closing on 2026-06-30 — the last day
  of the human-approved Excel seed (production row, submitted_by set). Odoo's
  stock_move HISTORY is never used to reconstruct past stock: before July it
  carries large constant offsets (iron ore +19,960 t, coal +16,135 t against
  the plant's book), so only Odoo's daily FLOWS are trusted, applied to the
  plant's own number.

  ── How each ledger was verified (2026-10-15) ───────────────────────────
  Two independent checks, both against data the plant itself produced or
  Odoo itself holds — never "the arithmetic looks right":

  (1) The plant's own Production Report for 30.08.2026 (the MIS mail of
      that day, "1. Production Report 30.08.2026.xlsx", and the Stores
      "7. Materials Report 30.08.2026.xlsx", which agrees with it on every
      shared row). Its MTD (1–30 Aug) and YTD (1 Apr–30 Aug) received and
      consumed columns were compared with Odoo's flows summed over the same
      windows, and its closing stock with this roll on 30 Aug:

        ledger              30-Aug plant   roll    flows MTD / YTD vs Odoo
        iron ore              3,148.95    3,149    recv 3,790.22 / 7,170.24 exact; cons exact
        bauxite                 659.04      659    recv 464 / 1,203.56 exact; cons exact
        clay (OB)               476.62      477    recv 630.78 / 10,474.76 exact; cons exact
        industrial clay         318.12      318    recv 318.08 / 455.84 exact ONLY with RM000009
        own clinker             341.34      341    prod 61,522 / 247,206 exact; cons MTD exact*
        purchased clinker       220.86      221    recv 2,667.2 / 16,057.86 exact; cons exact
        gypsum                1,036.52    1,037    recv within 31 t MTD / 1.2 t YTD; cons 0.3 t*
        fine coal                31.21       31    prod 8,381 / 36,493.7 exact; cons exact
        coal (kiln+CPP)       3,870.37    3,840    recv 30.62 t short MTD and YTD (one truck the
                                                   plant booked by 30 Aug, Odoo validated later);
                                                   coal-mill burn and CPP burn exact
        limestone             3,335.22    3,335    recv on-date 593.42 exact; cons exact*
        * YTD consumption differs only by two Odoo cement entries stuck
          since June (CEM/2026/01027 'confirm', CEM/2026/01112 'draft'):
          790.50 + 267.96 = 1,058.46 t clinker, 53.68 + 18.32 = 72.00 t
          gypsum, 198.33 + 69.60 t limestone — all BEFORE the anchor, so the
          plant's 30-Jun closing already contains them and the roll is
          unaffected. (They are why the Apr–Jun replay was 1,058 t off.)

  (2) Odoo's LIVE on-hand (stock_quant) against the plant's 30-Jun book plus
      every flow Odoo has approved since — the comparison the live pull
      repeats every run (services/odooStockLedger.js, compareWithOnHand).
      Measured 2026-10-16: EXACT (≤ 0.01 t) for iron ore, bauxite, clay,
      limestone, coal, purchased clinker and fine coal. Three differ, each by
      exactly one movement the plant's report does not carry — named in the
      ledger's own comment below: industrial clay +18.42 (a stores issue),
      gypsum +32.36 (a return to the supplier), own clinker −2,000 (Odoo's
      manual month-start quantity float).

  CPP coal burn (coal_cpp) was also checked against the CPP's own daily
  generation workbooks for Jul–Sep: equal on all 77 filled operating days
  (1 Jul–20 Sep; the plant was down 14–18 Sep, where the workbook says 0 and
  Odoo has no entry — nothing is written; the September workbook's sheets
  after the 20th are unfilled).

  ── The rules every ledger shares ───────────────────────────────────────
  • Days are Africa/Dar_es_Salaam (EAT) days. Receipts are keyed on the day
    the GRN move was validated; mining transfers on the day the truck was
    WEIGHED (gross_date), which is the plant's own convention — clay
    receipts match the Excel on 85/91 days that way against 34/91 by the
    day Odoo created the record (the tickets are imported in a batch 1–2.5
    days after weighing). Period totals are identical either way.
  • Consumption fields are OWNED by the production autofill
    (config/odooProductionMap.js, written from Odoo's production_report
    API). This ledger never writes them; it reads the stored value so the
    report's own closing (open + recv − cons, the page's formula) is exactly
    the next day's opening. Only when a row lacks the field does the roll
    fall back to the same quantity read straight from Odoo — measured
    2026-10-15: stored == Odoo on every day 1 Jul–13 Oct for every field.
  • A day is only rolled past once it is SETTLED in Odoo for every process
    the ledger depends on (DEPENDENCY_TYPES): no entry of that type still in
    draft/confirm for the day, and Odoo already holds a complete entry dated
    `frontierDays` AFTER it — entries are booked the next morning, so
    "nothing yet" and "nothing happened" look the same until a later day
    appears.
    Measured 2026-10-15 11:30 EAT: all seven "unapproved" production entries
    after 30 Jun are dated 2026-10-14 and were created that morning — they
    are a day being entered, not stuck entries.
*/

/* Odoo process -> what blocks a day.
   `prod` types are custom_production_entry.type values; 'cpp' is cpp_entry;
   'mining' is custom_mining_transfer. Labels are for the reasons shown to
   officers ("waiting for Odoo raw meal entries after 2026-10-14").

   `frontierDays` — how far ahead a complete entry must exist before day D
   counts as closed. Measured 2026-10-16 on entry create times, 15 Aug–16 Oct:
     raw meal, clinker, coal mill: ONE entry per day, created the next
       morning ~10:00 — "an entry dated D+1 exists" never once preceded the
       last entry for D (0 leaks of 55–56 days). 1 day.
     cement: ~10 entries per day, created live through D AND into the next
       morning (last one for D up to D+1 ~13:00) while D+1's first entries
       already exist from 00:17 — a 1-day rule leaks on 52 of 58 days.
       Requiring an entry dated D+2 leaks once in 101 days (2026-07-11: one
       entry created 57.7 h after the day began), and that straggler is
       picked up by the next full rebuild. 2 days.
     cpp: one entry per day, created on the day itself ~10:00; no day has
       two complete entries (1 Jul–15 Oct). 1 day.
     mining: transfers count on their WEIGHING day (gross_date — see the
       clay ledger for why), but each weighing day's tickets are imported in
       one batch 1 to 2.5 days later (Aug–Oct: max 61 h after weighing). A
       1-day rule leaks once in 70 days; 2 days, never. 2 days. */
const DEPENDENCY_TYPES = Object.freeze({
  raw_meal:  { source: 'prod',   label: 'raw meal',              frontierDays: 1 },
  clinker:   { source: 'prod',   label: 'clinker',               frontierDays: 1 },
  coal_mill: { source: 'prod',   label: 'coal mill (fine coal)', frontierDays: 1 },
  cement:    { source: 'prod',   label: 'cement',                frontierDays: 2 },
  cpp:       { source: 'cpp',    label: 'CPP',                   frontierDays: 1 },
  mining:    { source: 'mining', label: 'mining transfer',       frontierDays: 2 },
});

/* Coal receipts split, Kiln row vs CPP row.

   Measured 2026-10-16 over every day 1 Apr–30 Jun with a coal receipt
   (45 days): on all 39 days where Odoo's day total equals the Excel's,
   the Excel puts State Mining Corporation's coal on the CPP row and every
   other supplier's (Market Insight, Jitegemee Holdings, Mchekanae Mining)
   on the Kiln row — 39/39, no exception. The 6 other days are receipt
   TIMING (the day's total itself differs), not a different split. The Stores
   report of 30.08.2026 files the two later suppliers the same way (SINO
   coal and Mchekane under COAL - KILN).

   The CPP vendor list is read from config/odooMaterialMap.js (destination
   'cpp'), so the Production and Raw Material reports cannot drift apart on
   who supplies the power plant. Everything else is Kiln coal; a supplier in
   neither KILN_VENDORS nor the CPP list still lands on the Kiln row (the
   combined total must stay exact) but is reported in the run summary as
   `unknownCoalVendors` so Stores can confirm it. */
const KILN_COAL_VENDORS = Object.freeze({
  CMLT0357: 'Market Insight Limited',
  CMLT0265: 'Jitegemee Holdings Company Limited',
  CMLT1895: 'Mchekanae Mining Limited',       // Excel Kiln row on 9/9 days it delivered (May–Jun)
  CMLT2182: 'SINO coal',                      // Stores report 30.08.2026: under COAL - KILN (448 t YTD)
});

/* The ledgers.

   open      opening-stock field(s). For coal, the FIRST field carries the
             pile (see COAL); the rest are left to the officer.
   inflows   fields that add to stock. `write:true` = this ledger writes it
             from `flows`; `write:false` = another writer owns it (the
             production autofill) and it is only read.
   outflows  fields that draw stock, same convention.
   flows     Odoo flow keys summed into the field (see services/
             odooStockLedger.js fetchFlows): 'recv:<code>' validated
             receipts, 'recvkiln:'/'recvcpp:<code>' the coal split,
             'transfer:<code>' complete mining transfers into the plant pile,
             'line:<type>:<code>' complete production-entry consumption,
             'prod:<type>' complete production-entry output, 'cpp_burn'
             complete CPP entries' coal.
   positiveZero  a written flow that is a positive statement even at 0 (a
             complete CPP entry reporting 0 t burned). Receipts never are:
             a day with no receipt is simply not written.
   dependsOn DEPENDENCY_TYPES keys that must be settled before the day closes.
   onhand    Odoo product codes and location scope ('internal' = every
             internal location; 'pile' = the plant's WIP pile location only)
             the closing is compared with.
   publish   false = computed for the run summary only, nothing written,
             every day shown blank with `heldReason`.
*/
const LEDGERS = Object.freeze([
  {
    key: 'iron_ore', label: 'Iron Ore', unit: 'MT',
    open: ['rmm_ironore_open'],
    inflows: [{ field: 'rmm_ironore_recv', write: true, flows: ['recv:RM000004'] }],
    outflows: [{ field: 'rmm_ironore_cons', write: false, flows: ['line:raw_meal:RM000004'] }],
    dependsOn: ['raw_meal'],
    onhand: { codes: ['RM000004'], scope: 'internal' },
    publish: true,
  },
  {
    key: 'bauxite', label: 'Bauxite', unit: 'MT',
    open: ['rmm_bauxite_open'],
    inflows: [{ field: 'rmm_bauxite_recv', write: true, flows: ['recv:RM000007'] }],
    outflows: [{ field: 'rmm_bauxite_cons', write: false, flows: ['line:raw_meal:RM000007'] }],
    dependsOn: ['raw_meal'],
    onhand: { codes: ['RM000007'], scope: 'internal' },
    publish: true,
  },
  {
    /* Industrial clay has TWO Odoo items feeding one report row: quarried
       ID Clay (QRM008, mining transfers) and purchased INDUSTRIAL CLAY
       (RM000009, GRN receipts). The plant's 30.08.2026 YTD received of
       455.84 t is exactly 137.76 (QRM008 transfers, Apr–Jun) + 318.08
       (RM000009, Aug) — with QRM008 alone the roll read 0 against the
       plant's 318.12. Known on-hand difference: Odoo issued 18.42 t of
       RM000009 via a stores Material Issue (CM/MTI/2026/03210, 6 Oct) that is
       not a production-report flow — surfaced by the comparison, not
       folded in, until Stores says whether it left this pile. */
    key: 'industrial_clay', label: 'Industrial Clay', unit: 'MT',
    open: ['rmm_industrialclay_open'],
    inflows: [{ field: 'rmm_industrialclay_recv', write: true, flows: ['transfer:QRM008', 'recv:RM000009'] }],
    outflows: [{ field: 'rmm_industrialclay_cons', write: false, flows: ['line:raw_meal:QRM008', 'line:raw_meal:RM000009'] }],
    dependsOn: ['raw_meal', 'mining'],
    onhand: { codes: ['QRM008', 'RM000009'], scope: 'internal' },
    publish: true,
  },
  {
    /* Clay (OB, QRM007). Receipts = every complete QRM007 mining transfer
       into the pile — mine-to-pile and stockyard-to-pile, through or
       bypassing the crusher — on its weighing day. Apr–Jun: 85/91 days
       equal to the Excel (the 6 others are the plant lumping 28–30 Apr into
       1 May and similar), total 7,400.24 t exact. 30.08.2026: MTD 630.78
       and YTD 10,474.76 t, both exact; closing 476.62 exact. Live pile:
       exact. The on-hand comparison is against the PILE location only:
       Odoo's 'CM/Stock CM' holds 1,448.68 t of QRM007 that is the quarry
       STOCKYARD (it leaves via "Stock Yard to Pile" transfers), not the
       plant's raw-mill pile — that, not a missing receipt source, is why an
       all-locations comparison read 1 t against 1,450 t. */
    key: 'clay', label: 'Clay', unit: 'MT',
    open: ['rmm_clay_open'],
    inflows: [{ field: 'rmm_clay_recv', write: true, flows: ['transfer:QRM007'] }],
    outflows: [{ field: 'rmm_clay_cons', write: false, flows: ['line:raw_meal:QRM007'] }],
    dependsOn: ['raw_meal', 'mining'],
    onhand: { codes: ['QRM007'], scope: 'pile' },
    publish: true,
  },
  {
    /* Limestone (crusher pile, WIP001).

       The rule that was "unresolved" on 2026-10-15 — crusher_production_
       entry plus SOME bypass transfers, 8,460 t off over Apr–Jun — is
       replaced by a measured one: receipts = EVERY complete WIP001 mining
       transfer into the pile (through the crusher AND "Bypass Crusher"
       direct-to-pile, from mine or stockyard), on its weighing day. The
       plant's own Excel/report figures it reproduces:
         Apr–Jun receipts      242,389.22 t = Excel 242,389.22 t, exact;
                               79/91 days equal (the rest are the plant
                               lumping days, e.g. 28–30 Apr into 1 May)
         30.08.2026 on-date    593.42 t = the 28 tickets weighed that day
         30.08.2026 closing    3,335.24 t vs the plant's 3,335.22 t
         Odoo live pile        to 0.01 t (2026-10-16)
         lowest closing        +579 t (14 Aug) — never negative
       The one non-obvious piece is the anchor catch-up (934.40 t weighed
       30 Jun, imported 2 Jul — services/odooStockLedger.js fetchFlows 2b):
       without it every figure above is short by exactly that amount.

       Not the same number as ls_crusher_prod_mt: the production autofill
       fills that from Odoo's crusher_production_entry, which is NOT what
       the plant's sheet called crusher production (its LS-crusher row and
       this receipt row were the same figure, = these transfers). */
    key: 'limestone', label: 'Limestone (crusher pile)', unit: 'MT',
    open: ['rmm_limestone_open'],
    inflows: [{ field: 'rmm_limestone_recv', write: true, flows: ['transfer:WIP001'] }],
    outflows: [
      { field: 'rmm_limestone_cons', write: false, flows: ['line:raw_meal:WIP001'] },
      { field: 'cm_limestone_cons', write: false, flows: ['line:cement:WIP001'] },
    ],
    dependsOn: ['raw_meal', 'cement', 'mining'],
    onhand: { codes: ['WIP001'], scope: 'pile' },
    publish: true,
  },
  {
    /* COAL — one pile in Odoo, two rows on the report.

       Odoo holds raw coal in one place (CM/Stock CM + CM/Quality Control).
       The report splits it into a Kiln row and a CPP row, and the plant
       moves tonnage between the two rows at will: 42 of 90 Apr–Jun day-pairs
       break with equal-and-opposite adjustments, and by 30.08.2026 the
       plant was drawing the CPP's burn from the KILN row while the CPP row
       sat flat at 535.77 t. None of those moves exist in Odoo. Rolling each
       row on its own (Kiln: other suppliers − coal-mill burn; CPP: STAMICO
       − CPP burn) drives the CPP row negative: 3,534 + 5,392 received −
       13,165 burned = −4,239 t by 14 Oct. So the per-row split of the
       OPENING cannot be produced without inventing it.

       What is written instead, every part of it a measured fact:
         coal_kiln_recv / coal_cpp_recv  receipts split by supplier (above)
         coal_cpp                        CPP burn, cpp_entry (91/91 Apr–Jun;
                                         Aug MTD 3,845 / YTD 20,689 exact)
         coal_kiln_open                  the WHOLE pile's opening (Kiln+CPP)
         coal_cpp_open                   left to the officer — blank
       so the report's COAL TOTAL (open, received, consumed, closing) is
       exact, and the two rows' own closings are not stock figures. If an
       officer types the CPP opening, the Kiln row is written as the pile
       minus that figure, so the total stays exact and the plant's own split
       is honoured; if they type the Kiln opening, that day re-anchors the
       pile at their figure (see services/odooStockLedger.js openingFor). */
    key: 'coal', label: 'Coal (Kiln + CPP)', unit: 'MT',
    open: ['coal_kiln_open', 'coal_cpp_open'],
    inflows: [
      { field: 'coal_kiln_recv', write: true, flows: ['recvkiln:RM000001'] },
      { field: 'coal_cpp_recv', write: true, flows: ['recvcpp:RM000001'] },
    ],
    outflows: [
      { field: 'coal_kiln', write: false, flows: ['line:coal_mill:RM000001'] },
      { field: 'coal_cpp', write: true, flows: ['cpp_burn'], positiveZero: true },
    ],
    dependsOn: ['coal_mill', 'cpp'],
    onhand: { codes: ['RM000001'], scope: 'internal' },
    publish: true,
    splitNote: 'Odoo keeps coal as one pile: the whole pile\'s opening is on the Kiln row and the CPP opening is left for the officer — the COAL TOTAL row is the stock figure.',
  },
  {
    /* Own clinker (WIP003). Inflow is kiln production, outflow the cement
       mills' draw — both owned by the production autofill. Exact against the
       plant's 30.08.2026 closing (341.34 t).

       Known on-hand difference, so nobody "fixes" it into the roll: Odoo's
       clinker quantity is adjusted by hand (+2,000 t "Product Quantity
       Updated" at the start of each month since 15 Jul, −2,000 t at month
       end; +2,000 t outstanding since 1 Oct) — a float that lets cement
       entries post while Odoo's own clinker book is short. It is not a
       physical movement and the plant's report does not carry it. */
    key: 'clinker_own', label: 'Clinker (own)', unit: 'MT',
    open: ['kiln_clinker_open'],
    inflows: [{ field: 'kiln_prod_mt', write: false, flows: ['prod:clinker'] }],
    outflows: [{ field: 'cm_clinker_own_cons', write: false, flows: ['line:cement:WIP003'] }],
    dependsOn: ['clinker', 'cement'],
    onhand: { codes: ['WIP003'], scope: 'pile' },
    publish: true,
  },
  {
    key: 'clinker_purchased', label: 'Clinker (purchased)', unit: 'MT',
    open: ['cm_clinker_purch_open'],
    inflows: [{ field: 'cm_clinker_purch_recv', write: true, flows: ['recv:RM000014'] }],
    outflows: [{ field: 'cm_clinker_purch_cons', write: false, flows: ['line:cement:RM000014'] }],
    dependsOn: ['cement'],
    onhand: { codes: ['RM000014'], scope: 'internal' },
    publish: true,
  },
  {
    /* Known on-hand difference: 32.36 t returned to the supplier on
       2026-07-10 (Delivery Order CM/DN/2026/17214). The plant's report does
       not net it — its YTD received at 30 Aug is 1.16 t from Odoo's gross
       receipts, not 33.5 t — so neither does the roll. */
    key: 'gypsum', label: 'Gypsum', unit: 'MT',
    open: ['cm_gypsum_open'],
    inflows: [{ field: 'cm_gypsum_recv', write: true, flows: ['recv:RM000003'] }],
    outflows: [{ field: 'cm_gypsum_cons', write: false, flows: ['line:cement:RM000003'] }],
    dependsOn: ['cement'],
    onhand: { codes: ['RM000003'], scope: 'internal' },
    publish: true,
  },
  {
    /* Fine coal (coal-mill bin, WIP004): output of the coal mill, fired in
       the kiln. A ~50 t bin turning over ~300 t a day, so an entry dated a
       day off drives one day's closing below zero (it did, −263 t on
       2026-08-09) while the cumulative stays right (exact on 30 Aug and on
       Odoo's live bin). Such a day is published blank, never negative. */
    key: 'fine_coal', label: 'Fine Coal (coal mill)', unit: 'MT',
    open: ['coalmill_open'],
    inflows: [{ field: 'coalmill_prod_mt', write: false, flows: ['prod:coal_mill'] }],
    outflows: [{ field: 'coalmill_cons_mt', write: false, flows: ['line:clinker:WIP004'] }],
    dependsOn: ['coal_mill', 'clinker'],
    onhand: { codes: ['WIP004'], scope: 'pile' },
    publish: true,
  },
]);

/* The day the roll starts from, and the report it takes its closing from. */
const ANCHOR = Object.freeze({ date: '2026-06-30', formType: 'production', shift: 'day' });

module.exports = { LEDGERS, DEPENDENCY_TYPES, KILN_COAL_VENDORS, ANCHOR };
