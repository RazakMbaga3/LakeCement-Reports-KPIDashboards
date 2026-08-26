#!/usr/bin/env python3
"""
verify-production.py — INDEPENDENT full-coverage verification of the
`production` form_type, separate from extract-production.py's own logic.

Re-derives all 22 facts fresh from the three Master Production Report
workbooks (own label-scan implementation, not importing extract-production.py)
and diffs against a fresh GET from the local API for EVERY day of
2026-04-01..2026-06-30 (91 dates) — full coverage, not a sample, since the
goal of this pass is proving every digit landed correctly.

Also checks a sample of raw-materials fields (written by a separate script
into the same `production` row) to confirm this pass's writes didn't
regress them.

Usage: python backend/scripts/verify-production.py
Requires: VERIFY_PROD_USER (default import-production), VERIFY_PROD_PASS
"""
import json
import os
import sys
import urllib.request
import urllib.error
import datetime
import openpyxl
import warnings
warnings.filterwarnings('ignore')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
API = os.environ.get('VERIFY_BASE_URL', 'http://localhost:5000/api')

PROD_USER = os.environ.get('VERIFY_PROD_USER', 'import-production')
PROD_PASS = os.environ.get('VERIFY_PROD_PASS')

WB_FOR_MONTH = {
    4: os.path.join(ROOT, "full Production Report april and may", "Master production report APRIL 26'.xlsx"),
    5: os.path.join(ROOT, "full Production Report april and may", "Master production report MAY 26'.xlsx"),
    6: os.path.join(ROOT, "Master production report JUNE 26'.xlsx"),
}
DAYS_IN_MONTH = {4: 30, 5: 31, 6: 30}

REGRESSION_SAMPLE_DATES = ['2026-04-01', '2026-05-15', '2026-06-30']
REGRESSION_FIELDS = ['rmm_limestone_open', 'rmm_clay_open', 'cm_starex_open',
                      'iuc_425r', 'spc_kiln_kwh']
# coal_ncv deliberately excluded: extract-raw-materials.py only writes it when
# the source NCV cell is non-zero, so it's legitimately absent on some dates
# (confirmed absent from the source itself on 2026-04-01) — not a regression.

TOLERANCE = 0.005  # half the r2() rounding unit — anything at/above is a real mismatch


def norm(v):
    return str(v).strip().upper() if v is not None else ""


def num(ws, row, col):
    if not col:
        return None
    v = ws.cell(row=row, column=col).value
    return v if isinstance(v, (int, float)) else None


def r2(n):
    return round(n * 100) / 100


def locate_col(ws, header_row, target, lo=1, hi=250):
    """Scan a header row left-to-right for an exact normalized match."""
    want = norm(target)
    for c in range(lo, hi + 1):
        if norm(ws.cell(row=header_row, column=c).value) == want:
            return c
    return None


def locate_grouped_col(ws, group_label, sub_label, span=6):
    """Row 1 carries a merged group label (e.g. 'Kiln'); row 2 carries the
    sub-column label (e.g. 'Rng Hrs') within `span` columns of the group's
    start. Independently walks row 1 first, then probes row 2 in that
    window — same two-row structure as the source, different code path
    from extract-production.py's find_group_col()."""
    want_group = norm(group_label)
    for c in range(1, 251):
        if norm(ws.cell(row=1, column=c).value) == want_group:
            hit = locate_col(ws, 2, sub_label, c, c + span - 1)
            if hit:
                return hit
    return None


def locate_grouped_col_any(ws, group_label, sub_labels, span=6):
    for lbl in sub_labels:
        c = locate_grouped_col(ws, group_label, lbl, span)
        if c:
            return c
    return None


def build_column_map(p2, cl, ce):
    m = {}
    m['kiln_run_hrs'] = (p2, locate_grouped_col(p2, 'Kiln', 'Rng Hrs'))
    m['cm1_425r_mt'] = (p2, locate_grouped_col(p2, 'Cement Mill (42.5)', 'Production'))
    m['cm1_325n_mt'] = (p2, locate_grouped_col(p2, 'Cement Mill (32.5', 'Production'))
    m['cm1_425n_mt'] = (p2, locate_grouped_col(p2, 'Cement Mill (42.5N)', 'Production'))
    m['cm1_opc_mt'] = (p2, locate_grouped_col(p2, 'Cement Mill (OPC)', 'Production'))
    m['cm2_425r_mt'] = (p2, locate_grouped_col(p2, 'Cement Mill- 2 (42.5)', 'Production'))
    m['cm2_325n_mt'] = (p2, locate_grouped_col(p2, 'Cement Mill -2 (32.5', 'Production'))
    m['cm2_425n_mt'] = (p2, locate_grouped_col(p2, 'Cement Mill -2(42.5N)', 'Production'))
    m['cm2_425n_bm_mt'] = (p2, locate_grouped_col(p2, 'Cement Mill -2(42.5 N BM)', 'Production'))

    m['kiln_clinker_open'] = (cl, locate_grouped_col(cl, 'Clinker', 'Opening Stock'))
    m['kiln_prod_mt'] = (cl, locate_grouped_col(cl, 'Clinker', 'Production'))
    m['cm_clinker_own_cons'] = (cl, locate_grouped_col(cl, 'Clinker', 'Consumption'))
    m['coal_kiln'] = (cl, locate_grouped_col(cl, 'KILN COAL', 'Consumption'))
    m['coal_cpp'] = (cl, locate_grouped_col(cl, 'cpp coal', 'Consumption'))
    purch_recv_col = locate_col(cl, 2, 'CLINKER PURCHASED')
    m['cm_clinker_purch_open'] = (cl, (purch_recv_col - 1) if purch_recv_col else None)
    m['cm_clinker_purch_recv'] = (cl, purch_recv_col)
    m['cm_clinker_purch_cons'] = (cl, (purch_recv_col + 1) if purch_recv_col else None)

    m['cm_gypsum_open'] = (ce, locate_grouped_col(ce, 'Gypsum', 'Opening Stock'))
    m['cm_gypsum_recv'] = (ce, locate_grouped_col(ce, 'Gypsum', 'Production'))
    m['cm_gypsum_cons'] = (ce, locate_grouped_col_any(ce, 'Gypsum', ['Cons wet', 'Consumption']))
    m['_starex_open'] = (ce, locate_grouped_col(ce, 'Starex', 'Opening Stock'))
    m['_starex_recv'] = (ce, locate_grouped_col(ce, 'Starex', 'Production'))
    m['_starex_cons'] = (ce, locate_grouped_col(ce, 'Starex', 'Consumption'))
    m['_mapei_open'] = (ce, locate_grouped_col(ce, 'Mapei', 'Opening Stock'))
    m['_mapei_recv'] = (ce, locate_grouped_col(ce, 'Mapei', 'Production'))
    m['_mapei_cons'] = (ce, locate_grouped_col(ce, 'Mapei', 'Consumption'))
    return m


FACT_KEYS = ['kiln_run_hrs', 'cm1_425r_mt', 'cm1_325n_mt', 'cm1_425n_mt', 'cm1_opc_mt',
             'cm2_425r_mt', 'cm2_325n_mt', 'cm2_425n_mt', 'cm2_425n_bm_mt',
             'kiln_clinker_open', 'kiln_prod_mt', 'cm_clinker_own_cons', 'coal_kiln', 'coal_cpp',
             'cm_clinker_purch_open', 'cm_clinker_purch_recv', 'cm_clinker_purch_cons',
             'cm_gypsum_open', 'cm_gypsum_recv', 'cm_gypsum_cons']


def independent_extract(colmap, row):
    out = {}
    for fact in FACT_KEYS:
        ws, col = colmap[fact]
        v = num(ws, row, col)
        if v is not None:
            out[fact] = r2(v)

    starex_open = num(colmap['_starex_open'][0], row, colmap['_starex_open'][1])
    starex_recv = num(colmap['_starex_recv'][0], row, colmap['_starex_recv'][1])
    starex_cons = num(colmap['_starex_cons'][0], row, colmap['_starex_cons'][1])
    mapei_open = num(colmap['_mapei_open'][0], row, colmap['_mapei_open'][1])
    mapei_recv = num(colmap['_mapei_recv'][0], row, colmap['_mapei_recv'][1])
    mapei_cons = num(colmap['_mapei_cons'][0], row, colmap['_mapei_cons'][1])
    if starex_open is not None or mapei_open is not None:
        out['cm_grind_aid_open'] = r2((starex_open or 0) + (mapei_open or 0))
    if starex_recv is not None or mapei_recv is not None:
        out['cm_grind_aid_recv'] = r2((starex_recv or 0) + (mapei_recv or 0))
    if starex_cons is not None or mapei_cons is not None:
        out['cm_grind_aid_cons'] = r2((starex_cons or 0) + (mapei_cons or 0))
    return out


GRADE_SUFFIX = {'32.5 N': '325n', '42.5 R': '425r', '42.5 N': '425n', 'OPC': 'opc', '42.5 N BM': '425n_bm'}


def find_row_by_label(ws, label, col, lo, hi):
    want = norm(label)
    for r in range(lo, hi + 1):
        if norm(ws.cell(row=r, column=col).value) == want:
            return r
    return None


def independent_extract_plant_ops(ws):
    """Independent from extract_plant_ops() in extract-production.py: locates
    each department row by scanning for its label within a window below the
    'PLANT OPERATIONS' anchor, rather than trusting a fixed offset — catches
    a case where the offset assumption doesn't hold for some day/month."""
    anchor = find_row_by_label(ws, 'PLANT OPERATIONS', 2, 1, 60)
    if anchor is None:
        return {}
    out = {}
    for label, prefix in [('LS CRUSHER', 'ls_crusher'), ('RAW MILL -1', 'rm1'),
                           ('RAW MILL -2', 'rm2'), ('COAL MILL', 'coalmill')]:
        row = find_row_by_label(ws, label, 3, anchor, anchor + 15)
        if row is None:
            continue
        run_hrs, open_v, prod, cons = num(ws, row, 6), num(ws, row, 9), num(ws, row, 10), num(ws, row, 13)
        if run_hrs is not None: out[f'{prefix}_run_hrs'] = r2(run_hrs)
        if open_v is not None: out[f'{prefix}_open'] = r2(open_v)
        if prod is not None: out[f'{prefix}_prod_mt'] = r2(prod)
        if cons is not None: out[f'{prefix}_cons_mt'] = r2(cons)

    cm1_anchor = find_row_by_label(ws, 'CEMENT MILL -1', 3, anchor, anchor + 20)
    if cm1_anchor:
        for r in range(cm1_anchor, cm1_anchor + 5):
            suffix = GRADE_SUFFIX.get(norm(ws.cell(row=r, column=4).value))
            if not suffix:
                continue
            run_hrs, open_v, cons = num(ws, r, 6), num(ws, r, 9), num(ws, r, 13)
            if run_hrs is not None: out[f'cm1_{suffix}_run_hrs'] = r2(run_hrs)
            if open_v is not None: out[f'cm1_{suffix}_open'] = r2(open_v)
            if cons is not None: out[f'cm1_{suffix}_cons_mt'] = r2(cons)

    cm2_anchor = find_row_by_label(ws, 'CEMENT MILL -2', 3, anchor, anchor + 25)
    if cm2_anchor:
        for r in range(cm2_anchor, cm2_anchor + 5):
            suffix = GRADE_SUFFIX.get(norm(ws.cell(row=r, column=4).value))
            if not suffix:
                continue
            run_hrs = num(ws, r, 6)
            if run_hrs is not None: out[f'cm2_{suffix}_run_hrs'] = r2(run_hrs)

    return out


def independent_extract_coal_open_recv(ws):
    """Independent from extract-raw-materials.py's coal handling: locates
    'TOTAL MATL - RAW MILL' then scans forward for the KILN/CPP sub-rows by
    label (own window, not the same fixed 6-row assumption)."""
    anchor = find_row_by_label(ws, 'TOTAL MATL - RAW MILL', 3, 1, 60)
    if anchor is None:
        return {}
    out = {}
    for r in range(anchor + 1, anchor + 10):
        d_label = norm(ws.cell(row=r, column=4).value)
        if d_label not in ('KILN', 'CPP'):
            continue
        prefix = 'coal_kiln' if d_label == 'KILN' else 'coal_cpp'
        open_v, recv_v = num(ws, r, 5), num(ws, r, 6)
        if open_v is not None: out[f'{prefix}_open'] = r2(open_v)
        if recv_v is not None: out[f'{prefix}_recv'] = r2(recv_v)
    return out


def api_get(pathname, token):
    req = urllib.request.Request(f'{API}{pathname}', headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def login():
    if not PROD_PASS:
        print("Set VERIFY_PROD_PASS in the environment before running.", file=sys.stderr)
        sys.exit(1)
    body = json.dumps({'username': PROD_USER, 'password': PROD_PASS}).encode()
    req = urllib.request.Request(f'{API}/auth/login', data=body,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req) as resp:
        payload = json.loads(resp.read().decode())
    print(f"Logged in as {PROD_USER} (role {payload['user']['role']})")
    return payload['token']


def daterange(year, month, days):
    for d in range(1, days + 1):
        yield f"{year}-{month:02d}-{d:02d}", d


def main():
    token = login()

    match, mismatch, missing, source_error = 0, 0, 0, 0
    mismatches = []
    source_errors = []

    print("\n=== FULL-COVERAGE VERIFICATION — 91/91 days, fresh GET vs fresh Excel re-derivation ===\n")
    for month, wb_path in WB_FOR_MONTH.items():
        wb = openpyxl.load_workbook(wb_path, data_only=True)
        p2, cl, ce = wb['Production2'], wb['Clinker'], wb['Cement']
        colmap = build_column_map(p2, cl, ce)
        unresolved = [k for k, (ws, c) in colmap.items() if c is None]
        if unresolved:
            print(f"  WARNING ({wb_path}): columns not found: {unresolved}")

        for date_str, day in daterange(2026, month, DAYS_IN_MONTH[month]):
            row = day + 2
            expected = independent_extract(colmap, row)
            if str(day) in wb.sheetnames:
                day_ws = wb[str(day)]
                expected.update(independent_extract_plant_ops(day_ws))
                expected.update(independent_extract_coal_open_recv(day_ws))

            record = api_get(f'/reports/production/{date_str}', token)
            actual = (record or {}).get('data', {})

            d_match = d_mismatch = d_missing = 0
            for k, v in expected.items():
                av = actual.get(k)
                if av is None:
                    d_missing += 1
                    mismatches.append((date_str, k, v, None, 'MISSING_DATA'))
                else:
                    try:
                        if abs(float(av) - float(v)) < TOLERANCE:
                            d_match += 1
                        else:
                            d_mismatch += 1
                            mismatches.append((date_str, k, v, av, 'MAPPING_BUG'))
                    except (TypeError, ValueError):
                        d_mismatch += 1
                        mismatches.append((date_str, k, v, av, 'MAPPING_BUG'))
            match += d_match; mismatch += d_mismatch; missing += d_missing
            status = 'OK' if (d_mismatch == 0 and d_missing == 0) else 'ISSUES'
            print(f"  {date_str}: {len(expected):2d} fields -> match={d_match} mismatch={d_mismatch} missing={d_missing}  [{status}]")

    print(f"\nTOTAL: match={match} mismatch={mismatch} missing={missing}")
    if mismatches:
        print("\nDetails:")
        for d, k, exp, act, cat in mismatches:
            print(f"  [{cat}] {d} {k}: expected={exp} actual={act}")

    print("\n=== REGRESSION CHECK — raw-materials fields in the same `production` row still intact ===\n")
    reg_ok = True
    for date_str in REGRESSION_SAMPLE_DATES:
        record = api_get(f'/reports/production/{date_str}', token)
        actual = (record or {}).get('data', {})
        present = [f for f in REGRESSION_FIELDS if f in actual]
        missing_f = [f for f in REGRESSION_FIELDS if f not in actual]
        print(f"  {date_str}: {len(present)}/{len(REGRESSION_FIELDS)} present" + (f"  MISSING={missing_f}" if missing_f else ""))
        if missing_f:
            reg_ok = False
    print(f"\nRegression check: {'PASS' if reg_ok else 'FAIL — see missing fields above'}")

    sys.exit(0 if (mismatch == 0 and missing == 0 and reg_ok) else 1)


if __name__ == '__main__':
    main()
