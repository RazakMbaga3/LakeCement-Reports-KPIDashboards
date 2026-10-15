"""All Odoo access lives here (direct read-only PostgreSQL connection to the Odoo database).

Uses pg8000 (pure Python) because Windows Application Control blocks psycopg's compiled DLL.

Public API:
    fetch_sales(start_utc, end_utc) -> (orders_df, lines_df, register_df)
    fetch_register / fetch_targets / fetch_collections / fetch_customers / fetch_exemptions -> DataFrames (MIS report)
    latest_orders(limit) -> list of dicts (used by test_connection.py)

orders_df columns: id, name, date_utc, state, amount, customer, salesperson, team
lines_df columns:  order_id, product, qty, amount
"""
import os
import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import pg8000.native
import pg8000.exceptions

TIMEOUT_SECONDS = 120

# The dashboard starts with FY 2026-27: nothing dated before 1 April 2026 is fetched from Odoo.
DATA_START = date(2026, 4, 1)


def volume_discount_per_mt() -> float:
    """TZS per trade MT (VOLUME_DISCOUNT_PER_BAG x 20 bags); read when used, as .env is loaded after this import."""
    return float(os.getenv("VOLUME_DISCOUNT_PER_BAG", "528.02") or 528.02) * 20


def _from(start_local: date) -> date:
    return max(start_local, DATA_START)


class OdooError(Exception):
    """Raised with a user-friendly message (never contains the password)."""


def _settings():
    s = {
        "host": os.getenv("PG_HOST", "").strip(),
        "port": os.getenv("PG_PORT", "5432").strip() or "5432",
        "db": os.getenv("PG_DB", "").strip(),
        "user": os.getenv("PG_USER", "").strip(),
        "password": os.getenv("PG_PASSWORD", "").strip(),
    }
    names = {"host": "PG_HOST", "db": "PG_DB", "user": "PG_USER", "password": "PG_PASSWORD"}
    missing = [names[k] for k in names if not s[k] or s[k].lower() == "false"]
    if missing:
        raise OdooError("Odoo database settings not set in .env: " + ", ".join(missing))
    return s


def _connect(s):
    try:
        return pg8000.native.Connection(
            user=s["user"], password=s["password"], host=s["host"], port=int(s["port"]),
            database=s["db"], timeout=TIMEOUT_SECONDS, application_name="sales-dashboard")
    except pg8000.exceptions.DatabaseError as e:
        raise OdooError(f"Odoo database login failed - check PG_DB, PG_USER and PG_PASSWORD in .env "
                        f"({_pg_message(e)}).") from None
    except (pg8000.exceptions.InterfaceError, OSError) as e:
        raise OdooError(f"Cannot reach the Odoo database at {s['host']}:{s['port']} ({e}). "
                        "Check PG_HOST, network/VPN, firewall, and that PostgreSQL allows "
                        "remote connections (listen_addresses / pg_hba.conf).") from None


def _pg_message(e):
    arg = e.args[0] if e.args else e
    return arg.get("M", str(arg)) if isinstance(arg, dict) else str(arg)


def _name_expr(con, alias, table, column="name"):
    """Odoo 16+ stores translatable names as jsonb {"en_US": ...}; older versions as text."""
    rows = con.run("SELECT data_type FROM information_schema.columns "
                   "WHERE table_name = :t AND column_name = :c", t=table, c=column)
    col = f"{alias}.{column}"
    if rows and rows[0][0] == "jsonb":
        return f"COALESCE({col}->>'en_US', (SELECT j.value FROM jsonb_each_text({col}) j LIMIT 1))"
    return col


def _naive_utc(dt: datetime):
    """Odoo stores date_order as UTC timestamp without time zone."""
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _run(fn):
    s = _settings()
    con = _connect(s)
    try:
        return fn(con)
    except pg8000.exceptions.DatabaseError as e:
        raise OdooError(f"Odoo database returned an error: {_pg_message(e)}") from None
    except (pg8000.exceptions.InterfaceError, OSError) as e:
        raise OdooError(f"Lost connection to the Odoo database ({e}).") from None
    finally:
        con.close()


# Customer attributes come from the customer registration (res.partner of the invoice's commercial partner).
_CUSTOMER_JOINS = """
    LEFT JOIN res_partner c ON c.id = {partner}
    LEFT JOIN hr_employee emp ON emp.id = c.sales_emp_id
    LEFT JOIN crm_team dv ON dv.id = c.team_id
    LEFT JOIN res_zone_custom zn ON zn.id = c.zone_id
    LEFT JOIN res_district_custom dt ON dt.id = c.district_id
    LEFT JOIN res_country_state rg ON rg.id = c.state_id
"""
_CUSTOMER_COLS = """
    COALESCE(c.name, 'Unknown'), COALESCE(c.partner_code, ''), COALESCE(emp.name, 'Unassigned'),
    COALESCE(dv.name, 'Unassigned'), COALESCE(zn.name, 'Unassigned'), COALESCE(dt.name, ''),
    COALESCE(rg.name, ''), COALESCE(c.city, '')
"""
CUSTOMER_FIELDS = ["customer", "customer_code", "salesperson", "team", "zone", "district", "region", "city"]

# Sales Register (lc_reports "Sale Register Report" logic, checked against an exported register):
#   Net Value = untaxed (incl. excise) · Excise = "Excise Duty" lines · Freight = line freight per transport UoM
#   (per trip, or per bag / MT) · Net Realisation = Net Value - Excise - Freight · Invoice Value = total incl. VAT.
#   Credit notes (out_refund) are included with negative values.
_REGISTER_SQL = """
WITH inv AS (
    SELECT m.id, m.name, m.move_type, m.invoice_date, m.create_date, m.commercial_partner_id,
           CASE WHEN m.move_type = 'out_refund' THEN -1 ELSE 1 END AS sgn,
           m.amount_untaxed_signed, m.amount_total_signed, m.pricelist_type,
           so.id AS so_id, so.name AS so_name, so.date_order, tu.is_trip AS t_trip, tuom.factor AS t_factor,
           sg.name AS segment, st.name AS sale_type, cur.name AS currency
    FROM account_move m
    LEFT JOIN sale_order so ON so.id = m.sale_id
    LEFT JOIN sale_uom_master tu ON tu.id = so.transport_uom_id
    LEFT JOIN uom_uom tuom ON tuom.id = tu.uom_id
    LEFT JOIN sale_segment_custom sg ON sg.id = m.segment_id
    LEFT JOIN res_partner_category st ON st.id = m.categ_id
    LEFT JOIN res_currency cur ON cur.id = m.currency_id
    WHERE m.state = 'posted' AND m.move_type IN ('out_invoice', 'out_refund')
      AND m.invoice_date >= :s AND m.invoice_date < :e
), excise AS (
    SELECT l.move_id, SUM(l.balance) * -1 AS amt FROM account_move_line l JOIN inv ON inv.id = l.move_id
    WHERE l.product_id IS NULL AND NOT l.exclude_from_invoice_tab AND l.name ILIKE 'excise%%'
    GROUP BY l.move_id
), dn AS (
    SELECT DISTINCT ON (sp.sale_id) sp.sale_id, sp.name FROM stock_picking sp
    WHERE sp.sale_id IN (SELECT so_id FROM inv) AND sp.state = 'done'
    ORDER BY sp.sale_id, sp.date_done DESC
)
SELECT inv.id, inv.name, inv.move_type, inv.invoice_date, inv.create_date, inv.so_name, inv.date_order,
       dn.name,
       inv.segment, inv.sale_type, inv.pricelist_type, inv.currency,
       pp.default_code, pt.name, su.ref, su.is_bag,
       l.quantity * inv.sgn,
       CASE WHEN uc.name = 'Weight' AND luom.factor > 0 THEN l.quantity / luom.factor / 1000 ELSE 0 END * inv.sgn,
       l.balance * -1,
       CASE WHEN inv.t_trip THEN COALESCE(l.freight, 0)
            WHEN inv.t_factor IS NOT NULL AND luom.factor > 0 THEN COALESCE(l.freight, 0) * l.quantity / luom.factor * inv.t_factor
            ELSE COALESCE(l.freight, 0) * l.quantity END * inv.sgn,
       COALESCE(excise.amt, 0), inv.amount_untaxed_signed, inv.amount_total_signed,
       {customer_cols}
FROM inv
JOIN account_move_line l ON l.move_id = inv.id AND l.product_id IS NOT NULL
     AND NOT l.exclude_from_invoice_tab AND l.display_type IS NULL
LEFT JOIN product_product pp ON pp.id = l.product_id
LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
LEFT JOIN sale_uom_master su ON su.id = l.sale_uom_id
LEFT JOIN uom_uom luom ON luom.id = l.product_uom_id
LEFT JOIN uom_category uc ON uc.id = luom.category_id
LEFT JOIN excise ON excise.move_id = inv.id
LEFT JOIN dn ON dn.sale_id = inv.so_id
{customer_joins}
ORDER BY inv.invoice_date, inv.name, l.id
"""

# Sales register "Type" column: grade (from item code) + TRADE / PROJECT / BULK.
# SER042-044 are cement invoiced as service items ("[FG001] CEMENT 42.5 R" etc.).
_GRADE = {"FG001": "42.5", "FG002": "32.5", "FG003": "42.5 N", "FG004": "42.5 N OPC", "FG005": "42.5 N B-M",
          "SER042": "42.5", "SER043": "42.5 N", "SER044": "32.5"}
_BULK_AS_PLAIN = {"FG001", "SER042"}  # the register calls 42.5 R bulk just "BULK"

# Only these item codes count as sales (management list; excludes scrap steel, fly ash, vehicles, claims...).
# Matched against the Odoo product's Internal Reference (product_product.default_code).
SALES_ITEM_CODES = frozenset({"FG001", "FG002", "FG003", "FG004", "FG005", "SER042", "SER043", "SER044"})


def item_codes() -> frozenset:
    return SALES_ITEM_CODES

REGISTER_COLUMNS = [
    "invoice_id", "invoice", "move_type", "invoice_date", "so", "so_date", "dn", "segment", "sale_type",
    "delivery", "currency", "item_code", "item", "packing", "product_type", "bags", "mt",
    "net_value", "excise", "freight", "net_realisation", "invoice_value", *CUSTOMER_FIELDS]


def _tz():
    return ZoneInfo(os.getenv("TIMEZONE", "Africa/Dar_es_Salaam").strip() or "Africa/Dar_es_Salaam")


def _product_type(code, is_bag, sale_type):
    grade = _GRADE.get(code or "")
    if is_bag is False:
        return f"{grade} BULK" if grade and code not in _BULK_AS_PLAIN else "BULK"
    kind = "TRADE" if "trade" in (sale_type or "").lower() else "PROJECT"
    return f"{grade} {kind}" if grade else kind


def _register_rows(raw):
    """One row per invoice product line; invoice-level excise / net value / total split by line share.
    Shares use all product lines; lines whose item code is not in item_codes() are then dropped."""
    codes = item_codes()
    rows, by_inv = [], {}
    for r in raw:
        by_inv.setdefault(r[0], []).append(r)
    for lines in by_inv.values():
        line_total = sum(float(x[18] or 0) for x in lines)
        for x in lines:
            (inv_id, name, move_type, inv_date, _created, so, so_date, dn, segment, sale_type, pl_type, cur,
             code, item, packing, is_bag, qty, mt, line_amt, freight, excise, untaxed, total, *cust) = x
            if (code or "").strip().upper() not in codes:
                continue
            item = re.sub(r"^\[[^\]]*\]\s*", "", item or "")  # "[FG001] CEMENT 42.5 R" -> "CEMENT 42.5 R"
            share = float(line_amt or 0) / line_total if line_total else 1 / len(lines)
            ex = float(excise) * share
            nv = float(untaxed) * share
            fr = float(freight or 0)
            rows.append([
                inv_id, name, move_type, inv_date, so or "", so_date, dn or "", segment or "", sale_type or "",
                {"ex_work": "Ex Works", "delivered": "Delivered"}.get(pl_type, pl_type or ""), cur or "",
                code or "", item or "", packing or "", _product_type(code, is_bag, sale_type),
                float(qty or 0), float(mt or 0), nv, ex, fr, nv - ex - fr, float(total) * share, *cust])
    return pd.DataFrame(rows, columns=REGISTER_COLUMNS)


def fetch_register(start_local: date, end_local: date) -> pd.DataFrame:
    """Sales Register lines for invoice dates in [start_local, end_local] (inclusive)."""
    sql = _REGISTER_SQL.format(customer_cols=_CUSTOMER_COLS,
                               customer_joins=_CUSTOMER_JOINS.format(partner="inv.commercial_partner_id"))
    raw = _run(lambda con: con.run(sql, s=_from(start_local), e=end_local + timedelta(days=1)))
    return _register_rows(raw)


def fetch_sales(start_utc: datetime, end_utc: datetime):
    """Sales Register (posted invoices + credit notes) by invoice date.

    orders_df gets one row per invoice (state 'done'); amount = Net Value.
    """
    tz = _tz()
    start_local, end_local = start_utc.astimezone(tz).date(), (end_utc.astimezone(tz) - timedelta(seconds=1)).date()
    reg = fetch_register(start_local, end_local)
    # Net realisation = net value - excise - freight - volume discount (trade MT x TZS/bag x 20), as the MIS
    # "Sale Realization Summary"; the amount before the discount is kept in net_realisation_gross.
    adj = reg.assign(net_realisation_gross=reg.net_realisation,
                     net_realisation=reg.net_realisation - reg.mt * volume_discount_per_mt()
                     * reg.product_type.str.contains("TRADE"))  # working copy: the returned register stays unchanged

    # invoices carry a date only: place them at noon local time on the invoice date
    inv = adj.groupby("invoice_id", sort=False).agg(
        name=("invoice", "first"), invoice_date=("invoice_date", "first"), amount=("net_value", "sum"),
        mt=("mt", "sum"), bags=("bags", "sum"), net_realisation=("net_realisation", "sum"),
        net_realisation_gross=("net_realisation_gross", "sum"), invoice_value=("invoice_value", "sum"),
        **{f: (f, "first") for f in CUSTOMER_FIELDS + ["segment", "sale_type", "delivery"]}).reset_index()
    inv_dates = pd.to_datetime(inv.invoice_date) + pd.Timedelta(hours=12)
    orders_df = pd.DataFrame({
        "id": inv.invoice_id, "name": inv.name,
        "date_utc": inv_dates.dt.tz_localize(tz).dt.tz_convert("UTC") if len(inv) else pd.Series([], dtype="datetime64[ns, UTC]"),
        "state": "done", "amount": inv.amount,
        **{c: inv[c] for c in CUSTOMER_FIELDS + ["segment", "sale_type", "delivery", "mt", "bags",
                                                  "net_realisation", "net_realisation_gross", "invoice_value"]},
    })
    lines_df = pd.DataFrame({"order_id": adj.invoice_id, "product": adj["item"], "qty": adj.mt,
                             "amount": adj.net_value,
                             "net_realisation": adj.net_realisation})
    return orders_df, lines_df, reg


OPEN_ORDER_COLUMNS = ["id", "order", "order_date", "amount", "mt", *CUSTOMER_FIELDS]


def fetch_open_orders() -> pd.DataFrame:
    """Open Sales Orders: every approved sales order not yet (fully) delivered - no date range, current snapshot.
    Value / MT = the undelivered part of its sales item-code lines (untaxed); MT via the weight unit of measure."""
    sql = f"""
        WITH ol AS (
            SELECT l.order_id,
                   SUM(l.price_subtotal * GREATEST(l.product_uom_qty - l.qty_delivered, 0)
                       / NULLIF(l.product_uom_qty, 0)) AS amt,
                   SUM(CASE WHEN uc.name = 'Weight' AND u.factor > 0
                            THEN GREATEST(l.product_uom_qty - l.qty_delivered, 0) / u.factor / 1000 ELSE 0 END) AS mt
            FROM sale_order so
            JOIN sale_order_line l ON l.order_id = so.id AND l.display_type IS NULL
            JOIN product_product pp ON pp.id = l.product_id
            LEFT JOIN uom_uom u ON u.id = l.product_uom
            LEFT JOIN uom_category uc ON uc.id = u.category_id
            WHERE so.state IN ('sale', 'done') AND so.approval_status = 'approved'
              AND so.delivery_status IN ('not_delivered', 'partial')
              AND UPPER(TRIM(pp.default_code)) = ANY(:codes)
            GROUP BY l.order_id
            HAVING SUM(GREATEST(l.product_uom_qty - l.qty_delivered, 0)) > 0
        )
        SELECT so.id, so.name, so.date_order, ol.amt, ol.mt, {_CUSTOMER_COLS}
        FROM ol JOIN sale_order so ON so.id = ol.order_id
        {_CUSTOMER_JOINS.format(partner="(SELECT COALESCE(p.commercial_partner_id, p.id) FROM res_partner p WHERE p.id = so.partner_id)")}
        ORDER BY so.date_order
    """
    df = pd.DataFrame(_run(lambda con: con.run(sql, codes=sorted(item_codes()))), columns=OPEN_ORDER_COLUMNS)
    df["order_date"] = pd.to_datetime(df.order_date, utc=True).dt.tz_convert(_tz()).dt.tz_localize(None)
    return df.astype({"amount": float, "mt": float})


# Sales Target (Sales > Sales Target): approved monthly targets in MT per customer, split by cement grade.
# Customer attributes again come from the customer registration so they line up with the actuals.
TARGET_COLUMNS = ["month", "customer_id", "cem_425r", "cem_325", "cem_425n", "target", *CUSTOMER_FIELDS]


def fetch_targets(start_local: date, end_local: date) -> pd.DataFrame:
    """Approved sales-target lines (MT) for target months starting in [start_local, end_local]."""
    sql = f"""
        SELECT t.date_start, c.id, COALESCE(l.cement_one, 0), COALESCE(l.cement_two, 0), COALESCE(l.cement_three, 0),
               COALESCE(l.total_target, 0), {_CUSTOMER_COLS}
        FROM custom_sales_target_line l
        JOIN custom_sales_target t ON t.id = l.target_id AND t.state = 'approved' AND t.active
        {_CUSTOMER_JOINS.format(partner="(SELECT COALESCE(p.commercial_partner_id, p.id) FROM res_partner p WHERE p.id = l.partner_id)")}
        WHERE t.date_start >= :s AND t.date_start <= :e AND COALESCE(l.total_target, 0) <> 0
    """
    rows = _run(lambda con: con.run(sql, s=_from(start_local), e=end_local))
    df = pd.DataFrame(rows, columns=TARGET_COLUMNS)
    df["month"] = pd.to_datetime(df.month)
    return df.astype({c: float for c in ("cem_425r", "cem_325", "cem_425n", "target")})


COLLECTION_COLUMNS = ["date", "payment", "journal", "amount", *CUSTOMER_FIELDS, "reference"]


def fetch_collections(start_local: date, end_local: date) -> pd.DataFrame:
    """Posted customer receipts (account.payment inbound, customer) by accounting date, in company currency."""
    sql = f"""
        SELECT m.date, m.name, j.name, ABS(m.amount_total_signed), {_CUSTOMER_COLS}, COALESCE(m.ref, '')
        FROM account_payment p
        JOIN account_move m ON m.id = p.move_id AND m.state = 'posted'
        LEFT JOIN account_journal j ON j.id = m.journal_id
        {_CUSTOMER_JOINS.format(partner="(SELECT COALESCE(rp.commercial_partner_id, rp.id) FROM res_partner rp WHERE rp.id = p.partner_id)")}
        WHERE p.payment_type = 'inbound' AND p.partner_type = 'customer' AND m.date >= :s AND m.date <= :e
    """
    rows = _run(lambda con: con.run(sql, s=_from(start_local), e=end_local))
    df = pd.DataFrame(rows, columns=COLLECTION_COLUMNS)
    df["date"] = pd.to_datetime(df.date)
    return df.astype({"amount": float})


JV_COLUMNS = ["date", "jv", "reference", "amount", *CUSTOMER_FIELDS]


def fetch_jv_collections(start_local: date, end_local: date) -> pd.DataFrame:
    """Collection by JV: posted Miscellaneous (general journal) entries whose Reference contains both "Amount Transfer"
    and "Cement Supply".
    Amount = credit - debit on the customer's receivable lines (what the JV settles against the customer's account)."""
    sql = f"""
        SELECT m.date, m.name, COALESCE(m.ref, ''), l.credit - l.debit, {_CUSTOMER_COLS}
        FROM account_move_line l
        JOIN account_move m ON m.id = l.move_id AND m.state = 'posted'
        JOIN account_journal j ON j.id = m.journal_id AND j.type = 'general'
        JOIN account_account a ON a.id = l.account_id AND a.internal_type = 'receivable'
        {_CUSTOMER_JOINS.format(partner="(SELECT COALESCE(rp.commercial_partner_id, rp.id) FROM res_partner rp WHERE rp.id = l.partner_id)")}
        WHERE m.ref ILIKE '%amount transfer%' AND m.ref ILIKE '%cement supply%' AND m.date >= :s AND m.date <= :e
    """
    rows = _run(lambda con: con.run(sql, s=_from(start_local), e=end_local))
    df = pd.DataFrame(rows, columns=JV_COLUMNS)
    df["date"] = pd.to_datetime(df.date)
    df = df.astype({"amount": float})
    keys = [c for c in JV_COLUMNS if c != "amount"]  # one row per JV and customer
    return df.groupby(keys, as_index=False, dropna=False).amount.sum().sort_values(["date", "jv"]).reset_index(drop=True)


def fetch_customer_refunds(start_local: date, end_local: date) -> pd.DataFrame:
    """Customer refunds paid out: posted Miscellaneous entries whose Reference contains "Customer Refund" and that debit
    the customer's receivable account. Returned as NEGATIVE amounts (they reduce collection)."""
    sql = f"""
        SELECT m.date, m.name, COALESCE(m.ref, ''), l.credit - l.debit, {_CUSTOMER_COLS}
        FROM account_move_line l
        JOIN account_move m ON m.id = l.move_id AND m.state = 'posted'
        JOIN account_journal j ON j.id = m.journal_id AND j.type = 'general'
        JOIN account_account a ON a.id = l.account_id AND a.internal_type = 'receivable'
        {_CUSTOMER_JOINS.format(partner="(SELECT COALESCE(rp.commercial_partner_id, rp.id) FROM res_partner rp WHERE rp.id = l.partner_id)")}
        WHERE m.ref ILIKE '%customer refund%' AND l.debit > 0 AND m.date >= :s AND m.date <= :e
    """
    rows = _run(lambda con: con.run(sql, s=_from(start_local), e=end_local))
    df = pd.DataFrame(rows, columns=JV_COLUMNS)
    df["date"] = pd.to_datetime(df.date)
    df = df.astype({"amount": float})
    keys = [c for c in JV_COLUMNS if c != "amount"]
    return df.groupby(keys, as_index=False, dropna=False).amount.sum().sort_values(["date", "jv"]).reset_index(drop=True)


CUSTOMER_LIST_COLUMNS = ["customer_id", "partner_type", "tin", "country", *CUSTOMER_FIELDS]


def fetch_customers() -> pd.DataFrame:
    """Active registered customers (company-level partners with a customer code)."""
    sql = f"""
        SELECT c.id, COALESCE(c.partner_type, ''), COALESCE(c.tin_no, c.vat, ''), COALESCE(co.name, ''), {_CUSTOMER_COLS}
        FROM res_partner c0
        {_CUSTOMER_JOINS.format(partner="c0.id")}
        LEFT JOIN res_country co ON co.id = c.country_id
        WHERE c0.active AND c0.parent_id IS NULL AND COALESCE(c0.partner_code, '') <> '' AND c0.customer_rank > 0
    """
    df = pd.DataFrame(_run(lambda con: con.run(sql)), columns=CUSTOMER_LIST_COLUMNS)
    df["country"] = df.country.map(lambda v: v.get("en_US", "") if isinstance(v, dict) else v)
    df["partner_type"] = df.partner_type.str.title()
    return df


EXEMPTION_COLUMNS = ["certificate", "date", "customer", "customer_code", "issued_by", "proforma", "valid_to",
                     "cert_mt", "invoiced_mt", "state"]


def fetch_exemptions(valid_from: date) -> pd.DataFrame:
    """VAT exemption certificates still valid on/after valid_from, with MT invoiced against the same proforma."""
    sql = """
        SELECT e.name, e.date, COALESCE(c.name, ''), COALESCE(c.partner_code, ''), COALESCE(e.issued_by, ''),
               COALESCE(pi.name, ''), e.last_validity,
               (SELECT COALESCE(SUM(el.product_qty), 0) FROM custom_ec_line el WHERE el.ec_id = e.id),
               (SELECT COALESCE(SUM(CASE WHEN m.move_type = 'out_refund' THEN -1 ELSE 1 END
                                    * CASE WHEN u.factor > 0 THEN l.quantity / u.factor / 1000 ELSE 0 END), 0)
                FROM account_move m
                JOIN account_move_line l ON l.move_id = m.id AND l.product_id IS NOT NULL AND NOT l.exclude_from_invoice_tab
                JOIN uom_uom u ON u.id = l.product_uom_id
                WHERE e.proforma_id IS NOT NULL AND m.proforma_id = e.proforma_id AND m.state = 'posted'
                  AND m.move_type IN ('out_invoice', 'out_refund') AND m.invoice_date >= :start),
               e.state
        FROM custom_ec_master e
        LEFT JOIN res_partner c ON c.id = e.partner_id
        LEFT JOIN custom_proforma_invoice pi ON pi.id = e.proforma_id
        WHERE e.state <> 'cancelled' AND COALESCE(e.last_validity, e.validity_to) >= :d
        ORDER BY COALESCE(e.last_validity, e.validity_to) DESC, e.date DESC
    """
    df = pd.DataFrame(_run(lambda con: con.run(sql, d=valid_from, start=DATA_START)), columns=EXEMPTION_COLUMNS)
    return df.astype({"cert_mt": float, "invoiced_mt": float})


def latest_orders(limit: int = 5):
    """Server version + latest confirmed orders, for test_connection.py."""
    def query(con):
        version = con.run("SHOW server_version")[0][0]
        rows = con.run("""
            SELECT so.name, so.date_order, COALESCE(cp.name, '-'), COALESCE(up.name, '-'), so.amount_untaxed
            FROM sale_order so
            LEFT JOIN res_partner cp ON cp.id = so.partner_id
            LEFT JOIN res_users u ON u.id = so.user_id
            LEFT JOIN res_partner up ON up.id = u.partner_id
            WHERE so.state IN ('sale', 'done')
            ORDER BY so.date_order DESC LIMIT :n
        """, n=limit)
        return version, rows
    return _run(query)
