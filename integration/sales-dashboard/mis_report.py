"""MIS Sales Report builders: one function per sheet of the daily "SALES REPORT <date>" workbook.

Pure pandas (no Streamlit) so every sheet can be checked on its own. Inputs are the DataFrames returned by
odoo_client (register, targets, collections, customers, exemptions), already filtered by the dashboard.
Volumes are MT; targets are the approved Odoo Sales Target (MT per customer).
"""
import calendar
import re
from datetime import date

import pandas as pd

KEY = "customer_code"
REG_FIELDS = ["customer", "salesperson", "team", "zone", "region", "district", "city"]


def month_facts(d: date) -> dict:
    days = calendar.monthrange(d.year, d.month)[1]
    return {"start": d.replace(day=1), "days": days, "elapsed": d.day, "remaining": days - d.day}


def fy_start(d: date) -> date:
    """Financial year starts 1 April."""
    return date(d.year if d.month >= 4 else d.year - 1, 4, 1)


def _ratio(a, b):
    return a / b.where(b != 0) if isinstance(b, pd.Series) else (a / b if b else float("nan"))


def _between(df: pd.DataFrame, col: str, start: date, end: date) -> pd.DataFrame:
    s = pd.to_datetime(df[col])
    return df[(s >= pd.Timestamp(start)) & (s <= pd.Timestamp(end))]


def volume_discount(reg: pd.DataFrame, per_mt: float) -> pd.Series:
    """Volume discount = trade MT x rate (the workbook uses TZS 528.02 per bag = x20 per MT)."""
    return reg.mt * per_mt * reg.product_type.str.contains("TRADE")


# ---------------------------------------------------------------- OCT SALE REGISTER
def register_sheet(reg: pd.DataFrame, disc_per_mt: float, ncr_rate: float) -> pd.DataFrame:
    r = reg.sort_values(["invoice_date", "invoice"])
    ncr = _ratio(r.net_realisation, r.mt)
    return pd.DataFrame({
        "SO No": r.so, "SO Date": pd.to_datetime(r.so_date).dt.strftime("%d-%m-%Y"), "Invoice No": r.invoice,
        "Invoice Date": pd.to_datetime(r.invoice_date).dt.strftime("%d-%m-%Y"), "DN No": r.dn,
        "Customer Code": r.customer_code, "Customer": r.customer, "Segment": r.segment, "Type": r.product_type,
        "Sale Type": r.sale_type, "Division": r.team, "Zone": r.zone, "Region": r.region, "District": r.district,
        "Salesperson": r.salesperson, "Currency": r.currency, "Item Code": r.item_code, "Item": r.item,
        "UOM": r.packing, "Qty (bags)": r.bags, "Qty MT": r.mt,
        "Unit Rate w/o VAT": _ratio(r.net_value - r.excise, r.bags),
        "Net Value": r.net_value, "VAT": r.invoice_value - r.net_value, "Invoice Value": r.invoice_value,
        "Excise": r.excise, "Delivery": r.delivery, "Freight": r.freight, "Net Realisation": r.net_realisation,
        "Volume Discount": volume_discount(r, disc_per_mt), "NCR / MT": ncr, f"NCR @ {ncr_rate:g}": ncr / ncr_rate,
    })


# ---------------------------------------------------------------- OCT SR SUMMARY
def sr_summary(reg: pd.DataFrame, disc_per_mt: float, ncr_rate: float):
    """(by type, by grade, by delivery) - the three blocks of the SR SUMMARY sheet."""
    r = reg.assign(disc=volume_discount(reg, disc_per_mt))
    t = r.groupby("product_type", as_index=False).agg(mt=("mt", "sum"), nr=("net_realisation", "sum"),
                                                       fr=("freight", "sum"), disc=("disc", "sum"))
    t = t.sort_values("product_type")
    by_type = pd.DataFrame({
        "Type": t.product_type, "Qty MT": t.mt, "Net Realisation": t.nr, "NR less Volume Discount": t.nr - t.disc,
        "Freight": t.fr, "Volume Discount": t.disc, f"NCR @ {ncr_rate:g}": _ratio(t.nr - t.disc, t.mt) / ncr_rate,
    })
    g = r.groupby("item", as_index=False).mt.sum().sort_values("item")
    by_grade = pd.DataFrame({"Grade": g["item"], "Qty MT": g.mt, "Share %": _ratio(g.mt, g.mt.sum()) * 100})
    dl = r.groupby("delivery", as_index=False).mt.sum().sort_values("delivery")
    by_delivery = pd.DataFrame({"Delivery": dl.delivery, "Qty MT": dl.mt, "Share %": _ratio(dl.mt, dl.mt.sum()) * 100})
    return by_type, by_grade, by_delivery


# ---------------------------------------------------------------- customer master for the dealer sheets
def customer_frame(customers, targets, *activity) -> pd.DataFrame:
    """Registration details for every customer with a target or any activity (sales / collection)."""
    codes = set(targets[KEY])
    for df in activity:
        codes |= set(df[KEY])
    codes.discard("")
    base = customers.drop_duplicates(KEY).set_index(KEY)
    extra = pd.concat([targets[[KEY, *REG_FIELDS]], *[df[[KEY, *REG_FIELDS]] for df in activity]])
    extra = extra.drop_duplicates(KEY).set_index(KEY)
    out = base.reindex(sorted(codes))
    missing = out.customer.isna()
    out.loc[missing, REG_FIELDS] = extra.reindex(out.index[missing])[REG_FIELDS].values
    return out.reset_index()


EXCLUDED_COLLECTION_DIVISIONS = ("Unassigned", "D7")  # "Unassigned" and Div-7 are left out of every collection report


def exclude_divisions(df: pd.DataFrame) -> pd.DataFrame:
    """Drop the collection lines of the divisions that are not reported (Unassigned, Div-7)."""
    return df[~df["team"].isin(EXCLUDED_COLLECTION_DIVISIONS)] if len(df) else df


_REF_PATTERNS = [  # bank narration formats seen in the receipt Reference
    r"FT\s+FR\s?OM\s+(.+?)\s+TO\s+LAK\s?E",                       # CRDB agency / SIMAPP transfer
    r"From\s+LAKE\s+CEMENT\s+LIMITED\s*=>\s*(.+?)\W*$",           # NMB agency cash deposit
    r"Received payment from\s+\S+\s+\((.+?)\)",                   # NMB TIPS
    r"Sender's Ref\s+\S+\s+(.+?)\s+to\s+LAKE\s+CEMENT",           # NMB outgoing funds transfer
    r"(?:^|\s)-\s+([^-=]+?)\s*=>\s*LAKE\s+CEMENT\s+LIMITED",      # NMB internal fund transfer
]
_SUFFIX = re.compile(r"\b(LTD|LIMITED|CO|COMPANY|T/A|PLC)\b")
UNIDENTIFIED = "Unidentified payer (no name in reference)"


def payer_from_reference(ref: str) -> str:
    """Payer / customer name written in a bank receipt Reference ('' when the narration carries no name)."""
    txt = " ".join(str(ref or "").replace('"', " ").split())
    for pat in _REF_PATTERNS:
        m = re.search(pat, txt, flags=re.I)
        if m:
            return " ".join(m.group(1).split()).upper()
    return ""


def _norm_name(s: str) -> str:
    return " ".join(_SUFFIX.sub(" ", re.sub(r"[^A-Z0-9/ ]", " ", str(s).upper())).split())


def identify_from_reference(coll: pd.DataFrame, customers: pd.DataFrame) -> pd.DataFrame:
    """Receipts booked to no registered customer (e.g. 'Unknown Customer (Suspense Amount)'): take the payer from the
    Reference. A name equal to a registered customer gets that customer's full details; any other name is kept as
    'REF: <name>' (no customer code exists), and receipts whose Reference has no name stay as one unidentified line."""
    if coll.empty or "reference" not in coll:
        return coll
    out = coll.copy()
    todo = out.index[out[KEY].fillna("") == ""]
    if not len(todo):
        return out
    reg = customers.drop_duplicates(KEY).assign(_n=lambda x: x.customer.map(_norm_name))
    reg = reg[reg._n != ""].drop_duplicates("_n").set_index("_n")
    for i in todo:
        name = payer_from_reference(out.at[i, "reference"])
        if not name:
            out.loc[i, [KEY, "customer"]] = ["REF: UNIDENTIFIED", UNIDENTIFIED]
        elif _norm_name(name) in reg.index:
            r = reg.loc[_norm_name(name)]
            out.loc[i, [KEY, *REG_FIELDS]] = [r[KEY], *[r[f] for f in REG_FIELDS]]
        else:
            out.loc[i, [KEY, "customer"]] = [f"REF: {name}", f"{name} (per bank reference)"]
    return out


def _sum_by(df: pd.DataFrame, value: str) -> pd.Series:
    return df.groupby(KEY)[value].sum() if len(df) else pd.Series(dtype=float)


# ---------------------------------------------------------------- DEALER DASH BOARD
def dealer_dashboard(cust, targets, mtd, lm, coll_mtd, d: date) -> pd.DataFrame:
    f = month_facts(d)
    c = cust.set_index(KEY)
    tgt = _sum_by(targets, "target").reindex(c.index, fill_value=0)
    act = _sum_by(mtd, "mt").reindex(c.index, fill_value=0)
    last = _sum_by(lm, "mt").reindex(c.index, fill_value=0)
    col = _sum_by(coll_mtd, "amount").reindex(c.index, fill_value=0)
    pro = tgt / f["days"] * f["elapsed"]
    out = pd.DataFrame({
        "Zone": c.zone, "Division": c.team, "Salesperson": c.salesperson, "Dealer": c.customer,
        "Customer Code": c.index, "Target (MT)": tgt, "Prorated Target": pro, "Actual MTD (MT)": act,
        "% of Target": _ratio(act, tgt) * 100, "Last Month (MT)": last, "Diff from Target": act - tgt,
        "Diff from LM": last - act, "Collection MTD": col,
    })
    return out.sort_values(["Division", "Zone", "Salesperson", "Dealer"]).reset_index(drop=True)


# ---------------------------------------------------------------- Total sales & next month tgt
def sales_vs_target(cust, targets, mtd) -> pd.DataFrame:
    c = cust.set_index(KEY)
    act = _sum_by(mtd, "mt").reindex(c.index, fill_value=0)
    tgt = _sum_by(targets, "target").reindex(c.index, fill_value=0)
    out = pd.DataFrame({
        "Odoo Code": c.index, "Customer": c.customer, "Partner Type": c.get("partner_type", ""),
        "TIN": c.get("tin", ""), "City": c.city, "Zone": c.zone, "Region": c.region, "District": c.district,
        "Division": c.team, "Country": c.get("country", ""), "Salesperson": c.salesperson,
        "Sales MTD (MT)": act, "Target (MT)": tgt, "% Target": _ratio(act, tgt) * 100,
    })
    return out.sort_values(["Division", "Zone", "Salesperson", "Customer"]).reset_index(drop=True)


# ---------------------------------------------------------------- SALES / COLLECTION day-wise pivots
def day_pivot(df: pd.DataFrame, date_col: str, value: str, d: date, cust) -> pd.DataFrame:
    days = pd.date_range(month_facts(d)["start"], d, freq="D")
    x = df.assign(_day=pd.to_datetime(df[date_col]).dt.normalize())
    p = x.pivot_table(index=KEY, columns="_day", values=value, aggfunc="sum", fill_value=0).reindex(columns=days, fill_value=0)
    c = cust.drop_duplicates(KEY).set_index(KEY).reindex(p.index)
    p.columns = [f"{x:%d-%b}" for x in p.columns]
    out = pd.concat([pd.DataFrame({"Zone": c.zone, "Dealer": c.customer, "Customer Code": p.index}, index=p.index), p], axis=1)
    out["Total"] = p.sum(axis=1)
    return out.sort_values(["Zone", "Dealer"]).reset_index(drop=True)


# ---------------------------------------------------------------- YTD SALES (financial year, month-wise MT)
def ytd_pivot(reg_fy: pd.DataFrame, d: date, cust) -> pd.DataFrame:
    months = pd.period_range(fy_start(d), d, freq="M")[::-1]  # latest month first, as in the workbook
    x = reg_fy.assign(_m=pd.to_datetime(reg_fy.invoice_date).dt.to_period("M"))
    p = x.pivot_table(index=KEY, columns="_m", values="mt", aggfunc="sum", fill_value=0).reindex(columns=months, fill_value=0)
    c = cust.drop_duplicates(KEY).set_index(KEY).reindex(p.index)
    p.columns = [m.strftime("%b'%Y").upper() for m in p.columns]
    out = pd.concat([pd.DataFrame({"Zone": c.zone, "Dealer": c.customer, "Customer Code": p.index,
                                   "Country": c.get("country", "")}, index=p.index), p], axis=1)
    out["Total"] = p.sum(axis=1)
    return out.sort_values(["Zone", "Dealer"]).reset_index(drop=True)


# ---------------------------------------------------------------- TOTAL DIV WISE
def _ordinal(n: int) -> str:
    return f"{n:02d}" + ("TH" if 10 <= n % 100 <= 20 else {1: "ST", 2: "ND", 3: "RD"}.get(n % 10, "TH"))


def _natural(col: pd.Series) -> pd.Series:
    """Sort key: case-insensitive, numbers in order (DAR ES SALAAM 2 before DAR ES SALAAM 10)."""
    return col.str.upper().str.replace(r"\d+", lambda m: m.group().zfill(4), regex=True)


def div_label(team: str) -> str:
    """Odoo division "D1" -> "Div-1" as in the workbook."""
    return f"Div-{team[1:]}" if team[:1] == "D" and team[1:].isdigit() else team


def div_zone(targets, mtd, ftd, lm, coll_mtd, d: date, coll_fy=None) -> pd.DataFrame:
    """Division x zone (zone from the customer registration) with division subtotals, trade / projects / exports
    and grand total rows. Potential is not kept in Odoo, so it stays empty.
    coll_fy: collection of the whole financial year; adds one "<MON'YY> COLLECTION" column per month before the
    report month, ahead of the report month's MTD COLLECTION column."""
    f = month_facts(d)
    keys = ["team", "zone"]
    coll_col = f"{d:%b'%y}".upper() + " MTD COLLECTION"
    cols = {"ftd": f"FTD ON {_ordinal(d.day)} {d:%b'%Y}".upper()}
    prev_months = list(pd.period_range(fy_start(d), d, freq="M")[:-1]) if coll_fy is not None else []
    month_cols = [p.strftime("%b'%y").upper() + " COLLECTION" for p in prev_months]
    month_frames = [coll_fy[pd.to_datetime(coll_fy.date).dt.to_period("M") == p] for p in prev_months]

    def table(t, a, fd, l, c, *ms) -> pd.DataFrame:
        idx = pd.MultiIndex.from_frame(pd.concat([t[keys], a[keys], l[keys], c[keys], *[m[keys] for m in ms]])
                                       .drop_duplicates().sort_values(keys, key=_natural))
        out = pd.DataFrame({"Target": t.groupby(keys).target.sum(), "FTD": fd.groupby(keys).mt.sum(),
                            "MTD": a.groupby(keys).mt.sum(), "LM": l.groupby(keys).mt.sum(),
                            **{f"M{i}": m.groupby(keys).amount.sum() for i, m in enumerate(ms)},
                            "Coll": c.groupby(keys).amount.sum()}).reindex(idx).fillna(0.0)
        return out[out.abs().sum(axis=1) > 0]  # drop rows with no target, sales or collection

    frames = (targets, mtd, ftd, lm, coll_mtd, *month_frames)
    base = table(*frames)

    def subset(kind: str) -> pd.Series:
        """Totals for trade / projects / exports: projects = customers in a "Project" zone, exports = division D4."""
        def pick(df):
            export = df.team == "D4"
            project = df.zone.str.lower().str.contains("project") & ~export
            return df[{"export": export, "project": project, "trade": ~export & ~project}[kind]]
        return table(*map(pick, frames)).sum()

    def row(label_div, label_zone, b):
        t, mtd_, lm_ = b["Target"], b["MTD"], b["LM"]
        pro = t / f["days"] * f["elapsed"]
        return {"Division": label_div, "Zone": label_zone.upper(), "Potential": float("nan"),
                "Top Down Target": t, "Prorated TGT": pro, cols["ftd"]: b["FTD"], "MTD Sales": mtd_,
                "% Ach (Prorata Target)": _ratio(mtd_, pro) * 100, "Prorated TGT Shortfall": mtd_ - pro,
                "% Ach (Top Down Target)": _ratio(mtd_, t) * 100,
                "Projected Sales": mtd_ / f["elapsed"] * f["days"], "DRR": mtd_ / f["elapsed"],
                "Last Month Sales": lm_, "% LMTD": _ratio(mtd_, lm_) * 100,
                **{c: b[f"M{i}"] for i, c in enumerate(month_cols)}, coll_col: b["Coll"]}

    rows = []
    for team, grp in base.groupby(level=0, sort=True):
        rows += [row(div_label(team), z, b) for (_, z), b in grp.iterrows()]
        rows.append(row(f"Total {div_label(team)}", "", grp.sum()))
    rows.append(row("Total Trade", "", subset("trade")))
    rows.append(row("Total Projects", "", subset("project")))
    rows.append(row("Exports", "", subset("export")))
    rows.append(row("Grand Total", "", base.sum()))
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- Budget (Sales Target) vs Actual by salesperson
BVA_KEYS = {"team": ["team"], "zone": ["team", "zone"], "salesperson": ["team", "salesperson"],
            "customer": ["team", "zone", "salesperson", "customer_code", "customer"],
            "sp_dealer": ["salesperson", "customer_code", "customer"]}
BVA_LABELS = {"team": "Division", "zone": "Zone", "salesperson": "Salesperson", "customer_code": "Customer Code",
              "customer": "Customer"}


def budget_vs_actual(targets, mtd, d: date, by: str = "salesperson") -> pd.DataFrame:
    """Odoo Sales Target (MT) vs MTD invoiced MT, grouped by division / zone / salesperson / customer
    (all from the customer registration). Groups with neither target nor sales are left out."""
    f = month_facts(d)
    keys = BVA_KEYS[by]
    b = pd.DataFrame({"Target": targets.groupby(keys).target.sum(), "MTD": mtd.groupby(keys).mt.sum()}).fillna(0.0)
    b = b[(b.Target != 0) | (b.MTD != 0)].reset_index()
    b[keys] = b[keys].fillna("").astype(str)
    b = b.sort_values(keys, key=_natural).reset_index(drop=True)
    if "team" in b:
        b["team"] = b.team.map(div_label)
    pro = b.Target / f["days"] * f["elapsed"]
    proj = b.MTD / f["elapsed"] * f["days"]
    out = b[keys].rename(columns=BVA_LABELS)
    for col, v in {
        "Month Target (MT)": b.Target, "Prorated Target": pro, "MTD Actual (MT)": b.MTD,
        "Ach (Prorated) %": _ratio(b.MTD, pro) * 100, "Ach (Month) %": _ratio(b.MTD, b.Target) * 100,
        "Shortfall vs Prorated": b.MTD - pro, "DRR": b.MTD / f["elapsed"],
        "ARR": (b.Target - b.MTD) / f["remaining"] if f["remaining"] else float("nan"),
        "Projected (MT)": proj, "Projected Ach %": _ratio(proj, b.Target) * 100,
    }.items():
        out[col] = v
    return out


# ---------------------------------------------------------------- EXEMPTION
def exemption_sheet(ex: pd.DataFrame, d: date) -> pd.DataFrame:
    valid = pd.to_datetime(ex.valid_to)
    return pd.DataFrame({
        "Certificate No": ex.certificate, "Date": pd.to_datetime(ex.date).dt.strftime("%d-%m-%Y"),
        "Customer Code": ex.customer_code, "Customer": ex.customer, "Issued By": ex.issued_by,
        "Proforma No": ex.proforma, "Last Date of Validity": valid.dt.strftime("%d-%m-%Y"),
        "Certificate Qty (MT)": ex.cert_mt, "Invoiced Qty (MT)": ex.invoiced_mt,
        "Balance Qty (MT)": ex.cert_mt - ex.invoiced_mt,
        "Expiry Status": ["Expired" if v < pd.Timestamp(d) else "Not Expired" for v in valid],
        "State": ex.state.str.replace("_", " ").str.title(),
    })
