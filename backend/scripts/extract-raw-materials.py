#!/usr/bin/env python3
"""
extract-raw-materials.py — reads the plant's Master Production Report
workbooks (April/May/June 2026) and extracts the fields the prior
extract-production.py pass never touched:
  - PYRO PROCESSING raw-mill materials (Limestone/Clay/Iron Ore/
    Industrial Clay, plus Bauxite/Mill Dust Iron Ore which only start
    appearing partway through June)
  - Cement Grinding's own "LIMESTONE" (consumption-only, draws against
    the same physical stock as the raw-mill Limestone row) and "STAREX"
    rows (Grinding Aid's other component, distinct from the already-
    backfilled cm_grind_aid_* which is Starex+Mapie combined — see the
    accompanying report for why that's left alone, not "fixed" here)
  - Internal Use Cement (4 grades)
  - Specific Power 'Daily unit' sheet (9 department kWh columns)

Row positions are NOT stable: June inserts 2 blank spacer rows before
"TOTAL MATL - RAW MILL" starting day 1 (populated with real BAUXITE /
MILL DUST IRON ORE formulas only from day 21 onward), shifting every
row below by +2 for the whole month. This script therefore locates
every value by scanning column C (or E, for Internal Use Cement's
sub-grade labels) for label text fresh per day-sheet, never by a fixed
row number — see find_row()/find_rows_in_window().

Usage: python scripts/extract-raw-materials.py
Writes: scripts/_rawmat_<month>.json (one per configured month)
"""
import json
import os
import openpyxl
import warnings
warnings.filterwarnings('ignore')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

MONTHS = [
    {"file": os.path.join(ROOT, "full Production Report april and may", "Master production report APRIL 26'.xlsx"),
     "year": 2026, "month": 4, "days": 30},
    {"file": os.path.join(ROOT, "full Production Report april and may", "Master production report MAY 26'.xlsx"),
     "year": 2026, "month": 5, "days": 31},
    {"file": os.path.join(ROOT, "Master production report JUNE 26'.xlsx"),
     "year": 2026, "month": 6, "days": 30},
]

COL = {c: i for i, c in enumerate(
    ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'])}


def norm(v):
    return str(v).strip().upper() if v is not None else ""


def num(ws, row, col_letter):
    idx = COL[col_letter]
    v = ws.cell(row=row, column=idx).value
    return v if isinstance(v, (int, float)) else None


def r2(n):
    return round(n * 100) / 100


def find_row(ws, label, col_letter='C', r1=1, r2_=140):
    idx = COL[col_letter]
    target = norm(label)
    for r in range(r1, r2_ + 1):
        if norm(ws.cell(row=r, column=idx).value) == target:
            return r
    return None


def extract_day(ws):
    """Label-driven extraction for one day-sheet. Returns dict of facts."""
    out = {}

    # ── PYRO PROCESSING raw-mill materials ──────────────────────
    pyro_row = find_row(ws, 'PYRO PROCESSING')
    total_rm_row = find_row(ws, 'TOTAL MATL - RAW MILL', r1=pyro_row or 1) if pyro_row else None
    if pyro_row and total_rm_row:
        rm_materials = {
            'LIMESTONE': 'rmm_limestone',
            'CLAY': 'rmm_clay',
            'IRON ORE': 'rmm_ironore',
            'INDUSTRIAL CLAY': 'rmm_industrialclay',
            'BAUXITE': 'rmm_bauxite',
            'MILL DUST IRON ORE': 'rmm_milldustironore',
        }
        for r in range(pyro_row + 1, total_rm_row):
            label = norm(ws.cell(row=r, column=COL['C']).value)
            if label in rm_materials:
                prefix = rm_materials[label]
                o, f, i = num(ws, r, 'E'), num(ws, r, 'F'), num(ws, r, 'I')
                if o is not None: out[prefix + '_open'] = r2(o)
                if f is not None: out[prefix + '_recv'] = r2(f)
                if i is not None: out[prefix + '_cons'] = r2(i)

    # ── CEMENT GRINDING: Limestone (consumption-only) + Starex ──
    cg_row = find_row(ws, 'CEMENT GRINDING')
    total_cm_row = find_row(ws, 'TOTAL MATL - CEMENT MILL', r1=cg_row or 1) if cg_row else None
    if cg_row and total_cm_row:
        for r in range(cg_row + 1, total_cm_row):
            c_label = norm(ws.cell(row=r, column=COL['C']).value)
            d_label = norm(ws.cell(row=r, column=COL['D']).value)
            if c_label == 'LIMESTONE':
                f, i = num(ws, r, 'F'), num(ws, r, 'I')
                if f is not None: out['cm_limestone_recv'] = r2(f)
                if i is not None: out['cm_limestone_cons'] = r2(i)
            if d_label == 'STAREX':
                o, f, i = num(ws, r, 'E'), num(ws, r, 'F'), num(ws, r, 'I')
                if o is not None: out['cm_starex_open'] = r2(o)
                if f is not None: out['cm_starex_recv'] = r2(f)
                if i is not None: out['cm_starex_cons'] = r2(i)

    # ── Internal Use Cement (4 grades) ───────────────────────────
    iuc_row = find_row(ws, 'INTERNAL USE CEMENT')
    if iuc_row:
        grade_map = {'42.5': 'iuc_425r', '42.5N': 'iuc_425n', '32.5': 'iuc_325n', 'OPC': 'iuc_opc'}
        for r in range(iuc_row, iuc_row + 4):
            e_label = ws.cell(row=r, column=COL['E']).value
            key = None
            if isinstance(e_label, (int, float)):
                if abs(e_label - 42.5) < 0.01: key = 'iuc_425r'
                elif abs(e_label - 32.5) < 0.01: key = 'iuc_325n'
            elif isinstance(e_label, str):
                key = grade_map.get(e_label.strip().upper())
            if key:
                f = num(ws, r, 'F')
                if f is not None: out[key] = r2(f)

    # ── Coal NCV (kcal/kg coal) — manually-entered lab figure, label
    # "COAL NCV, KCAL / KG COAL" in column O, value one column right (Q) ──
    ncv_row = None
    for r in range(1, 140):
        v = ws.cell(row=r, column=COL['O']).value
        if isinstance(v, str) and 'NCV' in v.upper():
            ncv_row = r
            break
    if ncv_row:
        q = num(ws, ncv_row, 'Q')
        if q is not None and q != 0:
            out['coal_ncv'] = r2(q)

    return out


def extract_daily_unit(wb, day_num):
    if 'Daily unit' not in wb.sheetnames:
        return {}
    ws = wb['Daily unit']
    row = day_num + 2
    cols = {
        'spc_crusher_kwh': 'B', 'spc_rm1_kwh': 'C', 'spc_rm2_kwh': 'D',
        'spc_kiln_kwh': 'E', 'spc_coalmill_kwh': 'F', 'spc_cemmill_kwh': 'G',
        'spc_losses_kwh': 'H', 'spc_pplant_kwh': 'I', 'spc_others_kwh': 'J',
    }
    out = {}
    for field, col in cols.items():
        v = num(ws, row, col)
        if v is not None:
            out[field] = r2(v)
    return out


def main():
    for m in MONTHS:
        if not os.path.exists(m['file']):
            print(f"(skipping {m['file']} — not found)")
            continue
        wb = openpyxl.load_workbook(m['file'], data_only=True)
        sheetnames = set(wb.sheetnames)
        out = {}
        rm_days = 0
        cg_days = 0
        for day in range(1, m['days'] + 1):
            sn = str(day)
            if sn not in sheetnames:
                print(f"  WARNING day-sheet '{sn}' not found in {os.path.basename(m['file'])}")
                continue
            ws = wb[sn]
            data = extract_day(ws)
            data.update(extract_daily_unit(wb, day))
            if any(k.startswith('rmm_') for k in data):
                rm_days += 1
            if any(k.startswith('cm_limestone') or k.startswith('cm_starex') for k in data):
                cg_days += 1
            if data:
                date_str = f"{m['year']}-{m['month']:02d}-{day:02d}"
                out[date_str] = data

        out_path = os.path.join(HERE, f"_rawmat_{m['year']}-{m['month']:02d}.json")
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=1)
        print(f"=== {os.path.basename(m['file'])} ({m['year']}-{m['month']:02d}) ===")
        print(f"  {len(out)} days total, {rm_days} with raw-mill-material data, {cg_days} with cement-grinding limestone/starex")
        print(f"  wrote -> {out_path}\n")


if __name__ == '__main__':
    main()
