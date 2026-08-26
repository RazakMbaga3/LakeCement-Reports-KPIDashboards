# Apr–Jun 2026 production + power-cons re-seed & verification report

Date: 2026-08-21. Environment: local dev server/DB only (never the live Render API).

## Summary

| Dataset | Days | Fields checked | Match | Mismatch | Missing | Status |
|---|---|---|---|---|---|---|
| production | 91/91 | 3563 (23–38/day, see addendum) | 3563 | 0 | 0 | ✅ CLEAN |
| power-cons | 91/91 | 1729 (19/day) | 1729 | 0 | 0 | ✅ CLEAN |
| power-cons tonnage cross-check (pwr_kiln/cm1/cm2_prod_mt vs production) | 91/91 | 273 (3/day) | 273 | 0 | 0 | ✅ CLEAN |
| production ⇄ raw-materials regression | 3 sample dates | 5 fields | 15/15 present | — | — | ✅ PASS |
| CUMULATIVE DAILY vs IMS DATA date alignment | Apr/May/Jun | day-of-month per column | all aligned | — | — | ✅ PASS |

Every digit re-derived independently from the source Excel workbooks now matches Postgres exactly (tolerance 0.005, i.e. half the source rounding unit — not floating-point slop).

## What was done

1. Re-extracted production (`extract-production.py`) and raw-materials (`extract-raw-materials.py`) fresh from source — byte-identical to the existing git-tracked JSON cache, confirming the source workbooks haven't changed since the last extraction.
2. Re-imported production, raw-materials, and power-cons against the local server (idempotent upsert, no destructive delete needed).
3. Built two new full-coverage (91/91 day) independent verifiers — `verify-production.py`, `verify-power-cons.py` — since only raw-materials had a verify script before this pass, and that one only sampled 17 dates.
4. Found and root-caused two real gaps (both were bugs in the import tooling, not the source data):
   - **`2026-04-19` `pwr_kiln_prod_mt`**: `patch-power-production-tonnage.js` read `Clinker!EK` via ExcelJS, which drops the cached result for a formula cell that lacks an explicit `<v>` under ExcelJS's parser (confirmed: neighboring day rows carry a `result`, this one didn't). Fixed by rewriting the patch script to source these three fields from `extract-production.py`'s already openpyxl-verified JSON instead of re-parsing the workbook a second, less reliable way.
   - **`2026-04-02` `pwr_tanesco_kwh`**: same defect class — a *shared formula* cell in `CUMULATIVE DAILY` row 24 that ExcelJS exposes with no `result` at all (`{"sharedFormula":"B24"}`), while openpyxl correctly reads the true stored value (`0`). Found by `verify-power-cons.py`, fixed by the new `patch-power-cons-excel-gaps.py` (general-purpose: re-derives all facts via openpyxl and fills only genuinely absent keys, never overwrites a present value).
5. Both gaps are now closed and re-verified clean.

## Resolved decisions

**`pwr_utils_kwh`**: `import-power-cons.js`'s own header comment (~line 44-47) states this field "was removed from the registry and the power-cons form entirely on 2026-07-24 at the user's request, so it's no longer submitted." In fact it **is** still submitted — `verify-power-cons.py` confirms it's present on 91/91 live records, because the code's `ROW_FACT` map (line 86) never actually dropped row 13 → `pwr_utils_kwh` despite the comment. **Decision (2026-08-21): leave both the code and the data as-is for now** — neither the comment nor `ROW_FACT` was changed in this pass. Revisit before relying on this field's registry status elsewhere.

## Addendum (same day, after user-reported UI discrepancy): PLANT OPERATIONS section was never extracted at all

The user spotted, via screenshot comparison against source Excel, that the "PLANT OPERATIONS" dashboard widget shows 0 running hours for LS Crusher/Raw Mill-1/Raw Mill-2/Coal Mill (and per-grade running hours for Cement Mill 1 & 2) despite the source clearly having this data. Root cause: `extract-production.py` only ever read the monthly summary sheets (`Production2`/`Clinker`/`Cement`) — it never read each daily numbered sheet's own second table, headed "PLANT OPERATIONS", which is the *only* place this data exists. This predates today's session entirely; it was never wired up.

Fixed: extended `extract-production.py` with `extract_plant_ops()` — locates the "PLANT OPERATIONS" anchor row by label (its absolute position shifts month to month) then applies fixed relative offsets to each department/grade row, verified stable across April/May/June. Added 34 new fields: `ls_crusher_*`, `rm1_*`, `rm2_*`, `coalmill_*` (run_hrs/open/prod_mt/cons_mt), plus per-grade `cm1_*_run_hrs/_open/_cons_mt` and `cm2_*_run_hrs` (CM2 grades don't track open/consumption in the source at all — confirmed blank, not fabricated).

`verify-production.py` extended in parallel with an independently-written re-derivation (`independent_extract_plant_ops()` — locates rows by live label search within a window, not by trusting the same fixed-offset assumption as the extractor) and now checks 38 fields/day instead of 23. Re-verified 100% clean: 3563/3563 fields match across all 91 days.

**Process note**: re-running `import-production.js` (which replaces the whole `data` blob, no merge) after raw-materials had already been backfilled onto the same records wiped the raw-materials fields — caught immediately by the regression check, fixed by re-running `backfill-raw-materials.js` (GET-merge-POST) afterward. **Correct re-seed order going forward: `import-production.js` → `backfill-raw-materials.js` → `patch-power-production-tonnage.js`, always in that sequence** — reversing or repeating the first step alone will silently drop the merged-in fields.

## Credential/auth note (see also: dedicated import service accounts)

The `production` account was blocked by a legitimate forced-password-change gate (default seeded password, security hardening working as intended); `pm`'s password had already been changed by someone else and was unknown. Per your direction, created dedicated `import-production` / `import-pm` service accounts (roles `production`/`pm`, `must_change_password=false`, random generated passwords reported once at creation time) so these scripts never depend on — or need to touch — the real human-facing logins. See `create-import-service-accounts.js`.
