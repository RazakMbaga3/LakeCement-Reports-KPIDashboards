"""Odoo Live Sales Dashboard (Streamlit). Run: venv\\Scripts\\streamlit run app.py

Visual style follows Report-Templet.png (company portal look: navy header, orange accent,
greeting row, sectioned white cards with coloured left borders).
"""
import base64
import html
import re
import numbers
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from dotenv import load_dotenv
from streamlit_autorefresh import st_autorefresh

import auth
import mis_report as mis
import odoo_client

load_dotenv()

REFRESH_SECONDS = max(10, int(os.getenv("REFRESH_SECONDS", "60") or 60))
REFRESH_LABEL = (f"{REFRESH_SECONDS // 3600} hour{'s' if REFRESH_SECONDS >= 7200 else ''}" if REFRESH_SECONDS % 3600 == 0
                 else f"{REFRESH_SECONDS // 60} min" if REFRESH_SECONDS % 60 == 0 else f"{REFRESH_SECONDS}s")
RETRY_SECONDS = 300  # when Odoo is unreachable: retry every 5 minutes (keeps showing the last good data)
DATA_START = odoo_client.DATA_START  # 1 April 2026: start of FY 2026-27, nothing earlier is shown
TZ = ZoneInfo(os.getenv("TIMEZONE", "Africa/Dar_es_Salaam").strip() or "Africa/Dar_es_Salaam")
CURRENCY = os.getenv("CURRENCY", "TZS").strip() or "TZS"
SYMBOL = CURRENCY + " "
COMPANY_NAME = os.getenv("COMPANY_NAME", "Lake Cement Ltd.").strip() or "Lake Cement Ltd."
DEPARTMENT = os.getenv("DEPARTMENT", "Sales & Marketing").strip() or "Sales & Marketing"
LOGO_FILE = Path(__file__).with_name("logo.png")  # optional: drop your company logo here
# MIS report: volume discount on trade sales (TZS per 50 kg bag, 20 bags = 1 MT) and the USD rate for NCR
VOLUME_DISCOUNT_PER_BAG = float(os.getenv("VOLUME_DISCOUNT_PER_BAG", "528.02") or 528.02)
NCR_RATE = float(os.getenv("NCR_RATE", "2650") or 2650)
CONFIRMED = ("sale", "done")

# template palette
NAVY, NAVY_DARK, ORANGE, GREEN, RED = "#1b3a6b", "#16305a", "#f08a24", "#2e9e5b", "#d64545"
INK, MUTED, LINE, BG = "#1f2d3d", "#5b6b7f", "#e3e8ef", "#f4f6fa"
FONT = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
BN = 1e9  # charts plot values in billions
BN_LABEL = f"{SYMBOL.strip()} Billion"
MN = 1e6  # revenue is always shown in millions
MN_LABEL = f"{SYMBOL.strip()} Million"


# ---------------------------------------------------------------- formatting
def thousands(n: float) -> str:
    """1234567.8 -> '1,234,568' (whole number, thousands separators)."""
    return f"{n:,.0f}"


def money(x: float) -> str:
    """Short form for cards, captions and hovers: TZS 12.60 B / 8.27 M / 1.30 T."""
    for div, unit in ((1e12, "T"), (1e9, "B"), (1e6, "M")):
        if abs(x) >= div:
            return f"{SYMBOL}{x / div:,.2f} {unit}"
    return f"{SYMBOL}{thousands(x)}"


def money_mn(x: float) -> str:
    """Revenue: TZS 12,602.89 M."""
    return f"{SYMBOL}{x / MN:,.2f} M"


def is_revenue(col: str) -> bool:
    """Revenue columns (incl. last-year revenue and the running revenue total) are shown in millions."""
    return "Revenue" in col or col in ("Cumulative", "Open Sales Orders", "Collection")


def money_full(x: float) -> str:
    """Exact amount for table cells: TZS 12,602,900,412."""
    return f"{SYMBOL}{thousands(x)}"


def pct_change(cur: float, prev: float):
    return None if not prev else (cur - prev) / prev * 100


# ---------------------------------------------------------------- data
@st.cache_data(ttl=REFRESH_SECONDS, show_spinner="Loading sales data...")
def load(start_local: date, end_local: date):
    """Orders/lines with local order date in [start_local, end_local] (never before DATA_START)."""
    start_local = max(start_local, DATA_START)
    start_utc = datetime.combine(start_local, datetime.min.time(), TZ).astimezone(ZoneInfo("UTC"))
    end_utc = datetime.combine(end_local + timedelta(days=1), datetime.min.time(), TZ).astimezone(ZoneInfo("UTC"))
    orders, lines, reg = odoo_client.fetch_sales(start_utc, end_utc)
    local = orders["date_utc"].dt.tz_convert(TZ).dt.tz_localize(None)
    orders = orders.assign(date=local, day=local.dt.normalize())
    return orders, lines, reg, datetime.now(TZ)


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner="Loading sales targets...")
def load_targets(start_local: date, end_local: date) -> pd.DataFrame:
    """Approved Odoo Sales Target lines (MT per customer) for months starting in the period."""
    return odoo_client.fetch_targets(start_local, end_local)


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner="Loading open sales orders...")
def load_open_orders() -> pd.DataFrame:
    return odoo_client.fetch_open_orders()


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner="Loading collections...")
def load_collections(start_local: date, end_local: date) -> pd.DataFrame:
    return odoo_client.fetch_collections(start_local, end_local)


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner="Loading collection by JV...")
def load_jv_collections(start_local: date, end_local: date) -> pd.DataFrame:
    return odoo_client.fetch_jv_collections(start_local, end_local)


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner="Loading customer refunds...")
def load_customer_refunds(start_local: date, end_local: date) -> pd.DataFrame:
    return odoo_client.fetch_customer_refunds(start_local, end_local)


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner="Loading customers...")
def load_customers() -> pd.DataFrame:
    return odoo_client.fetch_customers()


@st.cache_data(ttl=REFRESH_SECONDS, show_spinner="Loading exemption certificates...")
def load_exemptions(valid_from: date) -> pd.DataFrame:
    return odoo_client.fetch_exemptions(valid_from)


@st.cache_resource
def _last_good() -> dict:
    """Last successful Odoo result per loader + arguments, shared by all users (kept when the cache is cleared)."""
    return {}


def keep_last_good(name, fn):
    """If Odoo fails, serve the last successful result (flagged in odoo_error) instead of an error page."""
    def wrapper(*args):
        try:
            result = fn(*args)
        except odoo_client.OdooError as e:
            if (name, args) not in _last_good():
                raise
            st.session_state["odoo_error"] = str(e)
            return _last_good()[(name, args)]
        _last_good()[(name, args)] = result
        return result
    return wrapper


load = keep_last_good("load", load)
load_targets = keep_last_good("targets", load_targets)
load_open_orders = keep_last_good("open_orders", load_open_orders)
load_collections = keep_last_good("collections", load_collections)
load_jv_collections = keep_last_good("jv_collections", load_jv_collections)
load_customer_refunds = keep_last_good("customer_refunds", load_customer_refunds)
load_customers = keep_last_good("customers", load_customers)
load_exemptions = keep_last_good("exemptions", load_exemptions)


# ---------------------------------------------------------------- template UI pieces
ICONS = {  # outline icons in the template's style (24x24, stroke=currentColor)
    "home": '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h5v-6h4v6h5V9"/>',
    "calendar": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    "trend": '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    "check": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    "bars": '<rect x="4" y="11" width="4" height="9" rx="1"/><rect x="10" y="5" width="4" height="15" rx="1"/><path d="M16 9h4v11h-4z"/>',
    "lines": '<path d="M4 6h16M4 12h10M4 18h16"/>',
    "receipt": '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    "file": '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h4"/>',
    "truck": '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
}


def icon(name: str, size: int = 22) -> str:
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{ICONS[name]}</svg>')


def inject_css():
    st.markdown(f"""
<style>
html, body, [class*="st-"], .stApp, .stMarkdown, button, input, textarea {{ font-family: {FONT}; }}
.stApp {{ background: {BG}; }}
header[data-testid="stHeader"] {{ background: transparent; }}
.block-container {{ padding-top: 1rem; padding-bottom: 2rem; max-width: 1600px; }}

/* filter bar (top, replaces sidebar) */
div[class*="st-key-filterbar"] {{ background: #fff; border: 1px solid {LINE}; border-left: 4px solid {ORANGE};
                                  border-radius: 10px; padding: 10px 16px 12px; margin-bottom: 14px; }}
div[class*="st-key-filterbar"] label p {{ font-weight: 700 !important; color: {NAVY_DARK} !important;
                                          font-size: .8rem !important; letter-spacing: .6px; text-transform: uppercase; }}
div[class*="st-key-filterbar"] [data-testid="stButton"] button {{ background: {NAVY_DARK}; border-color: {NAVY_DARK}; }}
div[class*="st-key-filterbar"] [data-testid="stButton"] button p {{ color: #fff !important; font-weight: 600; }}

/* top bar */
.lc-top {{ background: {NAVY_DARK}; border-radius: 10px 10px 0 0; padding: 12px 22px; display: flex;
          align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }}
.lc-brand {{ display: flex; align-items: center; gap: 14px; color: #fff; font-size: 1.35rem;
            font-weight: 500; letter-spacing: .5px; text-transform: uppercase; }}
.lc-logo {{ width: 42px; height: 42px; border-radius: 4px; background: {ORANGE}; color: #fff; display: flex;
           align-items: center; justify-content: center; font-weight: 700; font-size: .95rem; overflow: hidden; }}
.lc-logo-img {{ height: 50px; width: auto; display: block; border-radius: 2px; }}
.lc-user {{ display: flex; align-items: center; gap: 12px; color: #fff; font-weight: 600; font-size: .92rem; flex-wrap: wrap; }}
.lc-avatar {{ width: 34px; height: 34px; border-radius: 50%; background: {ORANGE}; display: flex;
             align-items: center; justify-content: center; font-weight: 700; color: {NAVY_DARK}; }}
.lc-chip {{ border: 1px solid rgba(255,255,255,.35); border-radius: 6px; padding: 5px 12px; font-size: .82rem;
           font-weight: 600; color: #fff; white-space: nowrap; }}
.st-key-login_box {{ background: #fff; border: 1px solid {LINE}; border-top: 4px solid {NAVY}; border-radius: 12px;
                    padding: 22px 26px; margin-top: 8vh; box-shadow: 0 6px 24px rgba(27,58,107,.08); }}
.lc-login-head {{ display: flex; align-items: center; gap: 14px; margin-bottom: 10px; color: {INK}; font-size: 1.1rem; }}
.lc-login-head .sub {{ color: {MUTED}; font-size: .85rem; font-weight: 500; }}
.lc-login-head .lc-logo, .lc-login-head .lc-logo-img {{ background: {NAVY}; border-radius: 8px; }}
.lc-chip.live {{ background: rgba(46,158,91,.2); border-color: {GREEN}; }}
.lc-accent {{ height: 3px; background: linear-gradient(90deg, {NAVY} 0 55%, {ORANGE} 55% 78%, {NAVY} 78%); }}

/* greeting row */
.lc-greet {{ background: #fff; border-bottom: 1px solid {LINE}; padding: 16px 22px 14px; display: flex;
            justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
            border-radius: 0 0 10px 10px; margin-bottom: 18px; }}
.lc-greet h2 {{ margin: 0; padding: 0; color: {NAVY_DARK}; font-size: 1.45rem; font-weight: 700; }}
.lc-greet .sub {{ color: {INK}; font-size: .9rem; margin-top: 2px; }}
.lc-date {{ border: 1px solid {LINE}; border-radius: 999px; padding: 6px 16px; color: {INK}; font-size: .9rem;
           background: {BG}; white-space: nowrap; }}

/* section heading: square + LABEL + count */
.lc-sec {{ display: flex; align-items: center; gap: 10px; margin: 22px 0 10px; font-weight: 700;
          letter-spacing: 1.6px; font-size: .85rem; color: {NAVY_DARK}; text-transform: uppercase; }}
.lc-sec .sq {{ width: 9px; height: 9px; border-radius: 2px; }}
.lc-sec .cnt {{ border: 1px solid {LINE}; border-radius: 999px; padding: 0 9px; font-size: .78rem;
               letter-spacing: 0; background: #fff; color: {INK}; }}

/* KPI cards */
.lc-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; }}
.lc-card {{ background: #fff; border: 1px solid {LINE}; border-left: 4px solid var(--acc); border-radius: 10px;
           padding: 18px 18px 16px; display: flex; gap: 14px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }}
.lc-card .ic {{ color: var(--acc); flex: none; margin-top: 2px; }}
.lc-card .t {{ font-weight: 700; color: {INK}; font-size: .98rem; }}
.lc-card .v {{ font-weight: 700; color: {NAVY_DARK}; font-size: 1.55rem; margin: 6px 0 4px; }}
.lc-card .d {{ color: {MUTED}; font-size: .84rem; line-height: 1.35; }}
.lc-pill {{ display: inline-block; border-radius: 5px; padding: 1px 7px; font-size: .78rem; font-weight: 700;
           margin-right: 6px; }}
.lc-pill.up {{ background: #e5f5ec; color: {GREEN}; }}
.lc-pill.down {{ background: #fbe9e9; color: {RED}; }}

/* chart / table cards = keyed bordered containers */
div[class*="st-key-card_"] {{ background: #fff; border: 1px solid {LINE} !important; border-radius: 10px;
                              box-shadow: 0 1px 2px rgba(16,24,40,.04); padding: 6px 8px; }}
div[class*="st-key-card_navy"] {{ border-left: 4px solid {NAVY} !important; }}
div[class*="st-key-card_green"] {{ border-left: 4px solid {GREEN} !important; }}
div[class*="st-key-card_orange"] {{ border-left: 4px solid {ORANGE} !important; }}
.lc-ct {{ display: flex; align-items: center; gap: 10px; font-weight: 700; color: {INK}; font-size: .98rem;
         padding: 8px 6px 0; }}
.lc-ct .ic {{ color: var(--acc); display: flex; }}
.lc-ct + .lc-cd {{ color: {MUTED}; font-size: .84rem; padding: 2px 6px 0 38px; }}

/* tables: full, coloured */
.lc-tbl-wrap {{ overflow-x: auto; border: 1.5px solid {NAVY_DARK}; border-radius: 8px; margin: 10px 0 12px; }}
table.lc-tbl {{ border-collapse: collapse; font-size: .86rem; margin: 0; border-style: hidden; table-layout: fixed; }}
table.lc-tbl th {{ background: {NAVY_DARK}; color: #fff; font-weight: 600; text-align: center; vertical-align: middle;
                   padding: 8px 12px; white-space: normal; overflow-wrap: break-word; line-height: 1.25;
                   border: 1px solid #3a5583; letter-spacing: .2px; }}
table.lc-tbl th:first-child {{ text-align: right; }}
table.lc-tbl td {{ padding: 8px 12px; border: 1px solid #cfd8e3; color: {INK}; vertical-align: middle; text-align: left;
                   white-space: normal; overflow-wrap: break-word; line-height: 1.3; }}
table.lc-tbl td.num {{ text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }}
table.lc-tbl td.ctr {{ text-align: center; }}
table.lc-tbl.fcr th:first-child {{ text-align: center; }}
table.lc-tbl.fcr td:first-child {{ text-align: left; }}
table.lc-tbl tbody tr:nth-child(even) td {{ background: #f3f6fb; }}
table.lc-tbl tbody tr:hover td {{ background: #fff3e6; }}
table.lc-tbl tfoot td {{ background: #fde8d2; color: {NAVY_DARK}; font-weight: 700; border-top: 2px solid {ORANGE}; }}
table.lc-tbl tbody tr.sub td {{ background: #fdf1e3; color: {NAVY_DARK}; font-weight: 700; }}
table.lc-tbl td.pos {{ color: {GREEN}; font-weight: 600; }}
table.lc-tbl td.neg {{ color: {RED}; font-weight: 600; }}
table.lc-tbl td.empty {{ text-align: center; color: {MUTED}; padding: 18px; }}
.lc-bar {{ display: flex; align-items: center; gap: 8px; min-width: 120px; }}
.lc-bar .trk {{ flex: 1; height: 8px; background: #e3e8f0; border-radius: 4px; overflow: hidden; }}
.lc-bar .fil {{ display: block; height: 100%; background: linear-gradient(90deg, {NAVY}, {ORANGE}); border-radius: 4px; }}
.lc-bar .val {{ width: 46px; text-align: right; font-variant-numeric: tabular-nums; }}
.lc-badge {{ display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: .78rem; font-weight: 600; }}
.lc-badge.q {{ background: #e8ecf2; color: {MUTED}; }}
.lc-badge.s {{ background: #fdebd6; color: #b85e00; }}
.lc-badge.o {{ background: #e3f4ea; color: {GREEN}; }}
.lc-badge.l {{ background: #e3e9f4; color: {NAVY}; }}

/* tabs */
[role="tablist"] {{ gap: 6px; border-bottom: 3px solid {ORANGE}; }}
[role="tab"] {{ background: #fff !important; border: 1px solid {LINE} !important; border-bottom: none !important;
               border-radius: 8px 8px 0 0 !important; padding: 9px 20px !important; margin: 0 !important; }}
[role="tab"] p {{ font-weight: 700 !important; color: {NAVY_DARK} !important; font-size: .92rem !important; }}
[role="tab"][aria-selected="true"] {{ background: {NAVY_DARK} !important; border-color: {NAVY_DARK} !important; }}
[role="tab"][aria-selected="true"] p {{ color: #fff !important; }}
[role="tab"]:hover:not([aria-selected="true"]) {{ background: {BG} !important; }}
</style>""", unsafe_allow_html=True)


def logo_html() -> str:
    if LOGO_FILE.exists():
        b64 = base64.b64encode(LOGO_FILE.read_bytes()).decode()
        return f'<img class="lc-logo-img" src="data:image/png;base64,{b64}" alt="logo">'
    initials = "".join(w[0] for w in COMPANY_NAME.replace(".", "").split()[:2]).upper()
    return f'<div class="lc-logo">{html.escape(initials)}</div>'


def header(now: datetime, fetched_at: datetime | None, next_at: datetime | None = None):
    hour = now.hour
    greeting = "Good morning" if hour < 12 else "Good afternoon" if hour < 17 else "Good evening"
    mode = '<span class="lc-chip live">● LIVE ODOO</span>'
    nxt = f" · Next {next_at:%H:%M}" if next_at else ""
    updated = (f'<span class="lc-chip" title="Last successful data refresh from Odoo">'
               f'⟳ Last refresh {fetched_at:%d %b %Y, %H:%M}{nxt}</span>' if fetched_at
               else '<span class="lc-chip">⟳ Not updated</span>')
    dept = html.escape(DEPARTMENT)
    st.markdown(f"""
<div class="lc-top">
  <div class="lc-brand">{logo_html()}<span>{html.escape(COMPANY_NAME)}</span></div>
  <div class="lc-user">{mode}{updated}<div class="lc-avatar">{html.escape(USER["name"][:1])}</div>
       <span>{html.escape(USER["name"])} · {html.escape(USER["level"])}</span></div>
</div>
<div class="lc-accent"></div>
<div class="lc-greet">
  <div><h2>{greeting}, {html.escape(USER["name"])}</h2>
       <div class="sub">{dept.upper()} · Live Sales Dashboard · auto-refresh every {REFRESH_LABEL}</div></div>
  <div class="lc-date">{now:%A}, {now.day} {now:%B %Y}</div>
</div>""", unsafe_allow_html=True)


def section(label: str, count: int | None, color: str):
    badge = f'<span class="cnt">{count}</span>' if count is not None else ""
    st.markdown(f'<div class="lc-sec"><span class="sq" style="background:{color}"></span>{html.escape(label)}'
                f'{badge}</div>', unsafe_allow_html=True)


def kpi_card(title: str, value: str, ic: str, accent: str, note: str = "", change: float | None = None) -> str:
    pill = ""
    if change is not None:
        cls, arrow = ("up", "▲") if change >= 0 else ("down", "▼")
        pill = f'<span class="lc-pill {cls}">{arrow} {abs(change):.1f}%</span>'
    return (f'<div class="lc-card" style="--acc:{accent}"><div class="ic">{icon(ic)}</div><div>'
            f'<div class="t">{html.escape(title)}</div><div class="v">{html.escape(value).replace(chr(10), "<br>")}</div>'
            f'<div class="d">{pill}{html.escape(note)}</div></div></div>')


def nr_card(conf: pd.DataFrame, accent: str) -> str:
    """Net Realisation per MT in TZS, with the USD equivalent at NCR_RATE."""
    mt = float(conf.mt.sum())
    nr = float(conf.net_realisation.sum()) / mt if mt else 0.0  # after volume discount, as the MIS Sale Realization Summary
    gross = float(conf.net_realisation_gross.sum()) / mt if mt else 0.0
    return kpi_card("Net Realisation / MT", f"{SYMBOL}{thousands(nr)}" + chr(10) + f"USD {nr / NCR_RATE:,.2f}", "receipt", accent,
                    f"Net value − excise − freight − volume discount, per MT · USD @ {NCR_RATE:g} · "
                    f"before discount USD {gross / NCR_RATE:,.2f}")


def kpi_grid(cards: list[str]):
    st.markdown(f'<div class="lc-grid">{"".join(cards)}</div>', unsafe_allow_html=True)


def card_title(title: str, desc: str, ic: str, accent: str):
    st.markdown(f'<div class="lc-ct" style="--acc:{accent}"><span class="ic">{icon(ic)}</span>{html.escape(title)}</div>'
                f'<div class="lc-cd">{html.escape(desc)}</div>', unsafe_allow_html=True)


def style_fig(fig, height=360):
    fig.update_layout(
        height=height, margin=dict(t=10, b=10, l=10, r=10), paper_bgcolor="#fff", plot_bgcolor="#fff",
        font=dict(family=FONT, color=INK, size=12),
        legend=dict(orientation="h", y=1.08, x=0), hoverlabel=dict(font_family="Inter, sans-serif"),
    )
    fig.update_xaxes(gridcolor=LINE, linecolor=LINE, zeroline=False)
    fig.update_yaxes(gridcolor=LINE, linecolor=LINE, zeroline=False)
    return fig


# ---------------------------------------------------------------- page
st.set_page_config(page_title=f"Sales Dashboard · {COMPANY_NAME}", page_icon="📈", layout="wide")
inject_css()
USER = auth.require_login(logo_html(), html.escape(COMPANY_NAME))  # stops here until signed in
SCOPE = USER["scope"]  # e.g. {"team": ["D1"]}: the user only ever sees that group's data
st.session_state.pop("odoo_error", None)  # set by keep_last_good when Odoo fails during this run


def restrict(df: pd.DataFrame) -> pd.DataFrame:
    """Apply the user's access scope (customer-registration group) before any other filter."""
    for col, allowed in SCOPE.items():
        if col in df.columns:
            df = df[df[col].isin(allowed)]
    return df


now = datetime.now(TZ)
today = now.date()
month_start = today.replace(day=1)
last_month_start = (month_start - timedelta(days=1)).replace(day=1)
year_start = mis.fy_start(today)  # financial year: April - March


def fy_label(fy: date) -> str:
    return f"FY {fy.year}-{(fy.year + 1) % 100:02d}"


header_slot = st.empty()  # filled once we know when data was fetched

# ---- filter bar (top of page); date first, the other options depend on the loaded data
with st.container(key="filterbar"):
    f_date, f_sp, f_team, f_zone, f_reg, f_cust, f_btn = st.columns([1.3, 1.2, 0.8, 1, 1, 1.4, 0.6],
                                                                    vertical_alignment="bottom")
    picked = f_date.date_input("Dashboard date range", value=(month_start, today), min_value=DATA_START, max_value=today,
                             format="DD/MM/YYYY")
    picked = tuple(picked) if isinstance(picked, (tuple, list)) else (picked,)
    picked = picked or (today,)  # mid-selection the widget may return one date (or none)
    range_start, range_end = picked[0], picked[-1]

fetch_start = max(DATA_START, min(range_start, year_start, last_month_start))
fetch_end = max(range_end, today)

try:
    orders_all, lines_all, register_all, fetched_at = load(fetch_start, fetch_end)
except Exception as e:
    with header_slot.container():
        header(now, None)
    if isinstance(e, odoo_client.OdooError):
        st.error(f"**Odoo is unreachable or not configured.**\n\n{e}")
    else:  # unexpected - still show something clear
        st.error(f"**Could not load sales data:** {type(e).__name__}: {e}")
    if st.session_state.pop("manual_refresh", False):
        st.error("**Refresh failed** - the data could not be reloaded from Odoo.")
    st.caption(f"Last attempt: {now:%d %b %Y, %H:%M:%S} · retrying automatically every {RETRY_SECONDS // 60} minutes")
    st_autorefresh(interval=RETRY_SECONDS * 1000, key="auto_refresh")
    st.stop()

orders_all, register_all = restrict(orders_all), restrict(register_all)

odoo_error = st.session_state.get("odoo_error")
if odoo_error:  # Odoo failed: keep showing the last good data and retry soon
    next_at = now + timedelta(seconds=RETRY_SECONDS)
else:  # next reload is due when the cached data is REFRESH_SECONDS old
    next_at = max(fetched_at + timedelta(seconds=REFRESH_SECONDS), now + timedelta(seconds=60))
st_autorefresh(interval=int((next_at - now).total_seconds() + 5) * 1000, key="auto_refresh")

with header_slot.container():
    header(now, fetched_at, next_at)
if odoo_error:
    st.warning(f"**Odoo is unreachable - showing the last successful data from {fetched_at:%d %b %Y, %H:%M}.** "
               f"Retrying automatically every {RETRY_SECONDS // 60} minutes.\n\n{odoo_error}")
if st.session_state.pop("manual_refresh", False):
    if odoo_error:
        st.error("**Refresh failed** - Odoo could not be reached; the figures below are from the last successful refresh.")
    else:
        st.toast(f"Data refreshed from Odoo at {fetched_at:%H:%M:%S}", icon="✅")


def options(col):
    return sorted(orders_all[col].dropna().unique())


sel_sp = f_sp.multiselect("Salesperson", options("salesperson"), placeholder="All salespersons")
sel_team = f_team.multiselect("Division", options("team"), placeholder="All")
sel_zone = f_zone.multiselect("Zone", options("zone"), placeholder="All zones")
sel_region = f_reg.multiselect("Region", [r for r in options("region") if r], placeholder="All regions")
sel_cust = f_cust.multiselect("Customer", options("customer"), placeholder="All customers")
if not USER["refresh"]:
    if f_btn.button("Log out", width="stretch", key="logout"):
        auth.logout()
elif f_btn.button("🔄 Refresh now", width="stretch",
                help=f"Reload all reports from Odoo now. Last updated {fetched_at:%d %b %Y, %H:%M:%S}; "
                     f"auto-refresh every {REFRESH_LABEL}."):
    st.cache_data.clear()  # sales, targets, collections, customers, exemptions
    st.session_state["manual_refresh"] = True
    st.rerun()



def apply_filters(df: pd.DataFrame) -> pd.DataFrame:
    df = restrict(df)
    for col, sel in (("salesperson", sel_sp), ("team", sel_team), ("zone", sel_zone), ("region", sel_region),
                     ("customer", sel_cust)):
        if sel:
            df = df[df[col].isin(sel)]
    return df


def open_orders() -> pd.DataFrame:
    """Open Sales Orders (approved, not delivered) as of now - not tied to any date range; page filters apply."""
    return apply_filters(load_open_orders())


def scoped(start: date, end: date):
    """Filtered orders with local day in [start, end] (+ all lines); reuses the main load when it covers the period."""
    start = max(start, DATA_START)
    if fetch_start <= start and end <= fetch_end:
        o, ln = orders_all, lines_all
    else:
        o, ln, _, _ = load(start, end)
    o = apply_filters(o)
    return o[(o.day >= pd.Timestamp(start)) & (o.day <= pd.Timestamp(end))], ln


def by_group(conf: pd.DataFrame, col: str, label: str, net_real: bool = False) -> pd.DataFrame:
    g = conf.groupby(col, as_index=False).agg(Invoices=("id", "count"), MT=("mt", "sum"), Revenue=("amount", "sum"),
                                              **{"Net Realisation Amount": ("net_realisation", "sum")})
    g["Net Realisation Rate/MT"] = g["Net Realisation Amount"] / g.MT.where(g.MT > 0)
    g = g.drop(columns="Net Realisation Amount")
    if not net_real:
        g = g.drop(columns="Net Realisation Rate/MT")
    g["Rate / MT"] = g.Revenue / g.MT.where(g.MT > 0)
    g["Share %"] = g.Revenue / g.Revenue.sum() * 100 if g.Revenue.sum() else 0.0
    return g.rename(columns={col: label}).sort_values("Revenue", ascending=False)


def add_collection(g: pd.DataFrame, label: str, col: str, coll: pd.DataFrame) -> pd.DataFrame:
    """Last column 'Collection' = customer receipts + collection by JV - customer refunds of the same group and period. Groups that only
    collected (no invoice in the period) are added, so the column adds up to the total collection."""
    c = coll.groupby(col).amount.sum()
    c.index.name = label
    g = g.set_index(label).join(c.rename("Collection"), how="outer")
    for k in ("Invoices", "MT", "Revenue", "Share %", "Collection"):
        if k in g:
            g[k] = g[k].fillna(0)
    if "Invoices" in g:
        g["Invoices"] = g["Invoices"].astype(int)
    return g.sort_values(["Revenue", "Collection"], ascending=False).reset_index()


def by_product(conf: pd.DataFrame, lines: pd.DataFrame, net_real: bool = False) -> pd.DataFrame:
    ln = lines[lines.order_id.isin(conf.id)]
    g = ln.groupby("product", as_index=False).agg(MT=("qty", "sum"), Revenue=("amount", "sum"))
    if net_real and "net_realisation" in ln:
        nr = ln.groupby("product").net_realisation.sum().reindex(g["product"]).to_numpy()
        g["Net Realisation Rate/MT"] = nr / g.MT.where(g.MT > 0)
    g["Share %"] = g.Revenue / g.Revenue.sum() * 100 if g.Revenue.sum() else 0.0
    return g.rename(columns={"product": "Product"}).sort_values("Revenue", ascending=False)


STATUS_CLASS = {"Sales Order": "o", "Locked": "l"}


def _total_row(df: pd.DataFrame, money_cols, pct_cols, total_fns=None) -> dict:
    """Totals for a summary table: sums, recomputed averages/shares/growth, last running total.
    total_fns: {column: fn(df) -> value} for ratios that must be recomputed from the column totals."""
    row = {df.columns[0]: "Total"}
    for c in df.columns[1:]:
        if total_fns and c in total_fns:
            row[c] = total_fns[c](df)
        elif c == "Cumulative":
            row[c] = df[c].iloc[-1] if len(df) else 0
        elif c == "Share %":
            row[c] = 100.0 if df[c].sum() else 0.0
        elif c == "Avg Order" and {"Revenue", "Orders"} <= set(df.columns):
            row[c] = df.Revenue.sum() / df.Orders.sum() if df.Orders.sum() else float("nan")
        elif c == "Net Realisation Rate/MT" and "MT" in df.columns:  # MT-weighted = total Net Realisation / total MT
            row[c] = (df[c].fillna(0) * df.MT).sum() / df.MT.sum() if df.MT.sum() else float("nan")
        elif c == "Rate / MT" and {"Revenue", "MT"} <= set(df.columns):
            row[c] = df.Revenue.sum() / df.MT.sum() if df.MT.sum() else float("nan")
        elif c in pct_cols:
            ly = [m for m in money_cols if m.endswith(" Revenue") and m != "Revenue"]
            row[c] = ((df.Revenue.sum() - df[ly[0]].sum()) / df[ly[0]].sum() * 100
                      if ly and "Revenue" in df and df[ly[0]].sum() else float("nan"))
        elif c.endswith("%"):  # a ratio: summing it is meaningless
            row[c] = float("nan")
        elif pd.api.types.is_numeric_dtype(df[c]):
            row[c] = df[c].sum()
        else:
            row[c] = ""
    return row


def _cell(col: str, v, money_cols, pct_cols, dec_cols=(), int_cols=(), right_cols=()) -> str:
    if col in right_cols and isinstance(v, str):  # pre-formatted numbers: right-aligned, never wrapped
        return f'<td class="num">{html.escape(v)}</td>'
    if col in money_cols:
        return f'<td class="num">{(money_mn if is_revenue(col) else money_full)(v) if pd.notna(v) else "-"}</td>'
    if col in int_cols and isinstance(v, numbers.Number):
        return f'<td class="num">{thousands(v) if pd.notna(v) else "-"}</td>'
    if col == "Share %":
        w = max(0.0, min(100.0, float(v))) if pd.notna(v) else 0.0
        return (f'<td><div class="lc-bar"><span class="trk"><span class="fil" style="width:{w:.1f}%"></span></span>'
                f'<span class="val">{w:.1f}%</span></div></td>')
    if col in pct_cols:
        if pd.isna(v):
            return '<td class="num">-</td>'
        return f'<td class="num {"pos" if v >= 0 else "neg"}">{"▲" if v >= 0 else "▼"} {abs(v):.1f}%</td>'
    if col == "Status" and v in STATUS_CLASS:
        return f'<td class="ctr"><span class="lc-badge {STATUS_CLASS[v]}">{html.escape(v)}</span></td>'
    if (col in ("MT", "Bags", "Total Qty in MT") or col in dec_cols) and isinstance(v, numbers.Number):
        return f'<td class="num">{v:,.2f}</td>' if pd.notna(v) else '<td class="num">-</td>'
    if col.endswith("%") and isinstance(v, numbers.Number):
        return f'<td class="num">{v:,.1f}%</td>' if pd.notna(v) else '<td class="num">-</td>'
    if isinstance(v, numbers.Number) and not isinstance(v, bool):
        return f'<td class="num">{thousands(v) if pd.notna(v) else "-"}</td>'
    txt = str(v)
    centred = bool(_DATE_RE.match(txt)) or any(k in col for k in _CENTRE_COLS)
    return f'<td{" class=ctr" if centred else ""}>{html.escape(txt)}</td>'


_DATE_RE = re.compile(r"^\d{2}-\d{2}-\d{4}$|^\d{4}-\d{2}-\d{2}$")
_CENTRE_COLS = ("Date", "Code", "Status", "Type", "Packing", "Delivery", "Segment", "Region", "Invoice No", "SO No",
                "DN No", "Day")


def _col_widths(df: pd.DataFrame, cells: list, foot_cells: list | None) -> list[float]:
    """Content-aware width (in ch) of each column, worked out from this table's own header and values."""
    plain = lambda h: html.unescape(re.sub(r"<[^>]+>", "", h))
    widths = []
    for j, c in enumerate(df.columns):
        col_txt = [plain(r[j]) for r in cells] + ([plain(foot_cells[j])] if foot_cells else [])
        longest = max((len(t) for t in col_txt), default=0)
        is_bar = c == "Share %"
        numeric = all(("num" in r[j][:30]) or is_bar for r in cells) if cells else False
        head_word = max((len(w) for w in str(c).split()), default=0) * 1.1
        head_all = len(str(c)) * 1.1
        if is_bar:
            w = 16
        elif numeric:
            w = max(longest, head_word, min(head_all, 14))
        else:  # text: may wrap, so cap the width and let the row grow
            w = max(min(longest, 34), head_word, min(head_all, 16), 6)
        widths.append(round(w + 0.5, 1))
    return widths


def show_table(df: pd.DataFrame, money_cols=(), pct_cols=(), total: bool = True, dec_cols=(), total_fns=None,
               strong_rows=(), int_cols=(), right_cols=(), first_col_right=False):
    """Full, coloured HTML table in the template style (navy header, striped rows, total row).
    dec_cols: shown with 2 decimals (MT). strong_rows: row positions styled like the total row (subtotals).
    right_cols: columns holding pre-formatted number text. first_col_right: first column left-aligned, header centred like the others."""
    numeric = {c for c in df.columns if c in money_cols or c in pct_cols
               or (pd.api.types.is_numeric_dtype(df[c]) and c != "Share %")}
    head = "".join(f"<th>{html.escape(c)}</th>" for c in df.columns)
    strong = set(strong_rows)
    cells = [[_cell(c, v, money_cols, pct_cols, dec_cols, int_cols, right_cols) for c, v in zip(df.columns, r)]
             for r in df.itertuples(index=False)]
    rows = "".join(f'<tr{" class=sub" if i in strong else ""}>' + "".join(r) + "</tr>" for i, r in enumerate(cells))
    foot, foot_cells = "", None
    if total and len(df) > 1:
        t = _total_row(df, money_cols, pct_cols, total_fns)
        foot_cells = [_cell(c, t[c], money_cols, pct_cols, dec_cols, int_cols, right_cols) for c in df.columns]
        foot = "<tfoot><tr>" + "".join(foot_cells) + "</tr></tfoot>"
    if df.empty:
        rows = f'<tr><td colspan="{len(df.columns)}" class="empty">No data</td></tr>'
        tbl_style, cols = "width:100%", ""
    else:
        ws = _col_widths(df, cells, foot_cells)
        cols = "<colgroup>" + "".join(f'<col style="width:calc({w}ch + 24px)">' for w in ws) + "</colgroup>"
        tbl_style = f"width:calc({sum(ws)}ch + {24 * len(ws)}px)"
    st.markdown(f'<div class="lc-tbl-wrap"><table class="lc-tbl{" fcr" if first_col_right else ""}" style="{tbl_style}">{cols}<thead><tr>{head}</tr></thead>'
                f"<tbody>{rows}</tbody>{foot}</table></div>", unsafe_allow_html=True)


def download(df: pd.DataFrame, label: str, file_name: str, key: str):
    if not USER["downloads"]:
        return
    st.download_button(f"⬇ {label}", df.to_csv(index=False).encode("utf-8-sig"), file_name=file_name,
                       mime="text/csv", key=key)


REGISTER_MONEY = ("Net Value", "Excise", "Freight", "Net Realisation", "Invoice Value")


def sales_register(conf: pd.DataFrame, d: date) -> pd.DataFrame:
    """Register lines of the (filtered) invoices dated d, in the Odoo Sale Register Report layout."""
    r = register_all[register_all.invoice_id.isin(conf.id)].sort_values("invoice")
    return pd.DataFrame({
        "Invoice Date": pd.to_datetime(r.invoice_date).dt.strftime("%d-%m-%Y"), "Invoice No": r.invoice,
        "SO No": r.so, "DN No": r.dn, "Customer Code": r.customer_code, "Customer": r.customer,
        "Salesperson": r.salesperson, "Division": r.team, "Zone": r.zone, "Region": r.region,
        "Segment": r.segment, "Type": r.product_type, "Sale Type": r.sale_type, "Item": r.item,
        "Packing": r.packing, "Delivery": r.delivery, "Bags": r.bags, "MT": r.mt, "Net Value": r.net_value,
        "Excise": r.excise, "Freight": r.freight, "Net Realisation": r.net_realisation,
        "Invoice Value": r.invoice_value})


# ================================================================ Dashboard tab
def dashboard_tab():
    orders = apply_filters(orders_all)
    confirmed = orders[orders.state.isin(CONFIRMED)]
    rs, re_ = pd.Timestamp(range_start), pd.Timestamp(range_end)
    in_range = orders[(orders.day >= rs) & (orders.day <= re_)]
    conf_range = in_range[in_range.state.isin(CONFIRMED)]
    quot_range = open_orders()

    def revenue_between(start: date, end: date) -> tuple[float, int]:
        d = confirmed[(confirmed.day >= pd.Timestamp(start)) & (confirmed.day <= pd.Timestamp(end))]
        return float(d.amount.sum()), len(d)

    # headline KPIs: always relative to today; respect salesperson/team/customer filters
    t_rev, t_cnt = revenue_between(today, today)
    yesterday = confirmed[(confirmed.day == pd.Timestamp(today - timedelta(days=1)))
                          & (confirmed.date <= pd.Timestamp(now.replace(tzinfo=None) - timedelta(days=1)))]
    y_rev = float(yesterday.amount.sum())  # yesterday up to the same time of day
    mtd_rev, mtd_cnt = revenue_between(month_start, today)
    same_day_last_month = min(today.day, month_start.toordinal() - last_month_start.toordinal())
    lm_same_rev, _ = revenue_between(last_month_start, last_month_start + timedelta(days=same_day_last_month - 1))
    lm_full_rev, lm_full_cnt = revenue_between(last_month_start, month_start - timedelta(days=1))
    ytd_rev, ytd_cnt = revenue_between(year_start, today)
    p_rev, p_cnt = float(conf_range.amount.sum()), len(conf_range)
    p_mt = float(conf_range.mt.sum())

    section("KPI & Analytics", 8, NAVY)
    kpi_grid([
        kpi_card("Today", money(t_rev), "home", NAVY, f"{t_cnt} invoices · vs yesterday", pct_change(t_rev, y_rev)),
        kpi_card("Month to Date", money(mtd_rev), "calendar", NAVY,
                 f"{mtd_cnt} invoices · vs same days last month", pct_change(mtd_rev, lm_same_rev)),
        kpi_card("Last Month", money(lm_full_rev), "lines", NAVY, f"{lm_full_cnt} invoices · {last_month_start:%B %Y}"),
        kpi_card(f"{fy_label(year_start)} to Date", money(ytd_rev), "trend", NAVY,
                 f"{ytd_cnt} invoices since {year_start:%d %b %Y}"),
    ])
    st.markdown(f'<div class="lc-sec" style="margin-top:14px;letter-spacing:.4px;text-transform:none;font-weight:600;'
                f'color:{MUTED}">Selected period: {range_start:%d %b %Y} – {range_end:%d %b %Y}</div>',
                unsafe_allow_html=True)
    kpi_grid([
        kpi_card("Net Value", money(p_rev), "bars", ORANGE, "Sales register, untaxed"),
        kpi_card("Volume", f"{p_mt:,.2f} MT", "truck", ORANGE, f"{p_cnt:,} invoices in period"),
        nr_card(conf_range, ORANGE),
        kpi_card("Open Sales Orders", money(float(quot_range.amount.sum())), "file", ORANGE,
                 f"{len(quot_range)} approved SOs not delivered · {quot_range.mt.sum():,.0f} MT · as of now"),
    ])

    if conf_range.empty and quot_range.empty:
        st.info("No invoices match the selected filters.")
        return

    def cumulative(start: date, n_days: int, col: str = "amount"):
        d = confirmed[(confirmed.day >= pd.Timestamp(start)) & (confirmed.day < pd.Timestamp(start + timedelta(days=n_days)))]
        return d.groupby(d.day.dt.day)[col].sum().reindex(range(1, n_days + 1), fill_value=0).cumsum()

    section("Trends & Analytics", 2, NAVY)
    with st.container(key="card_navy_budget"):
        month_days = (pd.Timestamp(month_start) + pd.offsets.MonthEnd(0)).day
        month_target = float(apply_filters(load_targets(month_start, month_start)).target.sum())
        mtd_target = month_target * today.day / month_days
        actual = cumulative(month_start, today.day, "mt")
        mtd_mt = float(actual.iloc[-1]) if len(actual) else 0.0
        achieved = (f" · Achievement {mtd_mt / mtd_target * 100:.1f}% ({mtd_mt:,.0f} of {mtd_target:,.0f} MT)"
                    if mtd_target else "")
        card_title("MTD Actual vs MTD Budget (Sales Target)",
                   f"Cumulative MT vs Odoo Sales Target phased evenly over {month_start:%B}{achieved}", "trend", NAVY)
        fig = go.Figure()
        if month_target:
            target_line = pd.Series([month_target * d / month_days for d in range(1, month_days + 1)],
                                    index=range(1, month_days + 1))
            fig.add_scatter(x=target_line.index, y=target_line, name="MTD Budget", mode="lines",
                            line=dict(color=NAVY, width=2.5, dash="dash"),
                            hovertemplate="Day %{x}: %{y:,.0f} MT<extra>MTD Budget</extra>")
        fig.add_scatter(x=actual.index, y=actual, name="MTD Actual", mode="lines+markers",
                        line=dict(color=ORANGE, width=3), marker=dict(size=6), fill="tozeroy",
                        fillcolor="rgba(240,138,36,.12)", hovertemplate="Day %{x}: %{y:,.2f} MT<extra>MTD Actual</extra>")
        fig.update_xaxes(range=[0.5, month_days + 0.5])
        st.plotly_chart(style_fig(fig).update_layout(xaxis_title="Day of month", yaxis_title="MT"), width="stretch")
        if not month_target:
            st.caption(f"No approved Sales Target in Odoo for {month_start:%B %Y}"
                       f"{' for the selected filters' if sel_sp or sel_team or sel_zone or sel_region or sel_cust else ''}.")

    with st.container(key="card_navy_mtd"):
        card_title("MTD Actual vs Last Month", "Cumulative revenue by day of month", "calendar", NAVY)
        fig = go.Figure()
        for label, s, color in (("Last month", cumulative(last_month_start, (month_start - last_month_start).days), "#9aa5b1"),
                                ("This month", cumulative(month_start, today.day), ORANGE)):
            fig.add_scatter(x=s.index, y=s / BN, name=label, mode="lines+markers", line=dict(color=color, width=2.5),
                            marker=dict(size=5), customdata=[money(v) for v in s],
                            hovertemplate="Day %{x}: %{customdata}<extra>" + label + "</extra>")
        st.plotly_chart(style_fig(fig).update_layout(xaxis_title="Day of month", yaxis_title=BN_LABEL), width="stretch")

    section("Top Performers", 2, GREEN)
    with st.container(key="card_green_products"):
        card_title("Top 10 Products", "By net value in the selected period", "bars", GREEN)
        top_products = by_product(conf_range, lines_all).head(10).rename(columns={"Revenue": "amount"})
        if top_products.empty:
            st.info("No product lines in the selected period.")
        else:
            top_bar(top_products, "Product")
    with st.container(key="card_green_customers"):
        card_title("Top 10 Customers", "By net value in the selected period", "truck", GREEN)
        top_customers = conf_range.groupby("customer", as_index=False).amount.sum().nlargest(10, "amount")
        if top_customers.empty:
            st.info("No invoices in the selected period.")
        else:
            top_bar(top_customers, "customer")

    section("Sales Team & Pipeline", 2, ORANGE)
    with st.container(key="card_orange_team"):
        card_title("Salesperson Performance", "Salesperson from customer registration · net value, MT, open sales orders "
                   "(approved, not delivered, as of now)",
                   "home", ORANGE)
        # one row per salesperson (a salesperson with customers in several divisions would otherwise be
        # split into several rows, and the open-SO value merged below would be counted once per row)
        perf = conf_range.groupby("salesperson", as_index=False).agg(
            team=("team", lambda s: ", ".join(sorted(set(s.dropna().astype(str))))),
            revenue=("amount", "sum"), orders=("id", "count"), mt=("mt", "sum"))
        pipe = quot_range.groupby("salesperson", as_index=False).agg(pipeline=("amount", "sum"), quotations=("id", "count"))
        coll_sp = collections_with_jv(range_start, range_end)[0].groupby("salesperson", as_index=False).amount.sum()
        perf = perf.merge(pipe, on="salesperson", how="outer").merge(
            coll_sp.rename(columns={"amount": "collection"}), on="salesperson", how="outer").fillna(
            {"revenue": 0, "orders": 0, "mt": 0, "pipeline": 0, "quotations": 0, "collection": 0})
        perf["team"] = perf["team"].fillna("-")
        perf["aov"] = perf.revenue / perf.orders.where(perf.orders > 0)
        perf["share"] = perf.revenue / perf.revenue.sum() * 100 if perf.revenue.sum() else 0
        perf = perf.sort_values("revenue", ascending=False)
        show_table(pd.DataFrame({
            "Salesperson": perf.salesperson, "Division": perf.team, "Revenue": perf.revenue,
            "Invoices": perf.orders.astype(int), "MT": perf.mt, "Share %": perf.share.round(1),
            "Open Sales Orders": perf.pipeline, "# Open SOs": perf.quotations.astype(int),
            "Collection": perf.collection,
        }), money_cols=("Revenue", "Open Sales Orders", "Collection"))
    with st.container(key="card_orange_pipeline"):
        card_title("Open Sales Orders vs Invoiced", "Approved sales orders not yet delivered (as of now), against "
                   "invoiced sales in the period", "check", ORANGE)
        stages = pd.DataFrame({
            "Stage": ["Open Sales Order (approved)", "Invoiced"],
            "amount": [float(quot_range.amount.sum()), p_rev],
            "count": [len(quot_range), p_cnt],
        })
        fig = px.bar(stages, x="Stage", y=stages.amount / BN, color="Stage",
                     text=[f"{money(a)}<br>{c} docs" for a, c in zip(stages.amount, stages["count"])],
                     color_discrete_sequence=[ORANGE, NAVY])
        fig.update_traces(hovertemplate="%{x}: %{text}<extra></extra>", textposition="outside", cliponaxis=False)
        st.plotly_chart(style_fig(fig).update_layout(showlegend=False, yaxis_title=BN_LABEL, xaxis_title=None,
                                                     margin=dict(t=40, b=10, l=10, r=10)), width="stretch")
        total_q = stages["count"].sum()
        if total_q:
            st.caption(f"{p_cnt} invoices in the period · {total_q - p_cnt} open sales orders (approved, not "
                       f"delivered, {quot_range.mt.sum():,.0f} MT) as of now.")


def top_bar(df: pd.DataFrame, label_col: str):
    df = df.sort_values("amount")
    fig = px.bar(df, x=df.amount / BN, y=label_col, orientation="h", custom_data=[df.amount.map(money)])
    fig.update_traces(marker_color=GREEN, hovertemplate="%{y}: %{customdata[0]}<extra></extra>")
    st.plotly_chart(style_fig(fig, 400).update_layout(xaxis_title=BN_LABEL, yaxis_title=None), width="stretch")


def breakdowns(conf: pd.DataFrame, lines: pd.DataFrame, key: str, file_tag: str, coll: pd.DataFrame):
    """Division / zone / salesperson / product / customer summary tables shared by the three reports.
    coll: collection of the same period (receipts + JV); the last column 'Collection' of every table that has one
    (collection cannot be split by product)."""
    div = add_collection(by_group(conf, "team", "Division", True), "Division", "team", coll)
    zone = add_collection(by_group(conf, "zone", "Zone", True), "Zone", "zone", coll)
    sp = add_collection(by_group(conf, "salesperson", "Salesperson", True), "Salesperson", "salesperson", coll)
    prod = by_product(conf, lines, True)
    cust = add_collection(by_group(conf, "customer", "Customer", True), "Customer", "customer", coll)
    money_cols = ("Revenue", "Rate / MT", "Collection")
    nr_cols = money_cols + ("Net Realisation Rate/MT",)
    with st.container(key=f"card_navy_{key}_div"):
        card_title("Division-wise", "Invoices, MT and net value per division (customer registration)", "lines", NAVY)
        show_table(div, money_cols=nr_cols)
        download(div, "Download CSV", f"division_{file_tag}.csv", f"dl_{key}_div")
    with st.container(key=f"card_navy_{key}_zone"):
        card_title("Zone-wise", "Invoices, MT and net value per zone (customer registration)", "truck", NAVY)
        show_table(zone, money_cols=nr_cols)
        download(zone, "Download CSV", f"zone_{file_tag}.csv", f"dl_{key}_zone")
    with st.container(key=f"card_orange_{key}_sp"):
        card_title("Salesperson-wise", "Salesperson from customer registration", "home", ORANGE)
        show_table(sp, money_cols=nr_cols)
        download(sp, "Download CSV", f"salesperson_{file_tag}.csv", f"dl_{key}_sp")
    with st.container(key=f"card_green_{key}_prod"):
        card_title("Product-wise", "MT and net value per product", "bars", GREEN)
        show_table(prod, money_cols=("Revenue", "Net Realisation Rate/MT"))
        download(prod, "Download CSV", f"products_{file_tag}.csv", f"dl_{key}_prod")
    with st.container(key=f"card_green_{key}_cust"):
        card_title("Customer-wise", "Invoices, MT and net value per customer", "truck", GREEN)
        show_table(cust, money_cols=nr_cols)
        download(cust, "Download CSV", f"customers_{file_tag}.csv", f"dl_{key}_cust")


# ================================================================ Daily Sales Report
def daily_report():
    section("Daily Sales Report", None, NAVY)
    d = st.date_input("Report date", value=today, max_value=today, format="DD/MM/YYYY", min_value=DATA_START, key="daily_date")
    prev = d - timedelta(days=1)
    o, lines = scoped(prev, d)
    day_o, prev_o = o[o.day == pd.Timestamp(d)], o[o.day == pd.Timestamp(prev)]
    conf, prev_conf = day_o[day_o.state.isin(CONFIRMED)], prev_o[prev_o.state.isin(CONFIRMED)]
    quot = open_orders()
    rev, cnt, prev_rev = float(conf.amount.sum()), len(conf), float(prev_conf.amount.sum())
    qty, prev_mt = float(conf.mt.sum()), float(prev_conf.mt.sum())

    kpi_grid([
        kpi_card("Net Value", money(rev), "bars", NAVY, f"vs {prev:%d %b} ({money(prev_rev)})", pct_change(rev, prev_rev)),
        kpi_card("Volume", f"{qty:,.2f} MT", "truck", NAVY, f"{prev_mt:,.2f} MT on {prev:%d %b}", pct_change(qty, prev_mt)),
        kpi_card("Invoices", f"{cnt:,}", "check", NAVY, f"{len(prev_conf)} on {prev:%d %b}",
                 pct_change(cnt, len(prev_conf))),
        nr_card(conf, NAVY),
        kpi_card("Open Sales Orders", money(float(quot.amount.sum())), "file", NAVY, f"{len(quot)} approved SOs not delivered · {quot.mt.sum():,.0f} MT · as of now"),
    ])
    if day_o.empty:
        st.info(f"No invoices on {d:%d %b %Y} for the selected filters.")
        return

    section("Volume by Zone", None, NAVY)
    with st.container(key="card_navy_daily_zonechart"):
        card_title("MT by Zone", f"Invoiced volume per zone on {d:%d %b %Y}", "truck", NAVY)
        zone_mt = conf.groupby("zone").mt.sum().sort_values(ascending=False)
        fig = go.Figure()
        fig.add_bar(x=zone_mt.index, y=zone_mt.values, marker_color=NAVY, text=[f"{v:,.0f}" for v in zone_mt],
                    textposition="outside", cliponaxis=False, hovertemplate="%{x}: %{y:,.2f} MT<extra></extra>")
        st.plotly_chart(style_fig(fig, 380).update_layout(yaxis_title="MT", xaxis_tickangle=-45), width="stretch")

    section("Breakdown", 3, ORANGE)
    breakdowns(conf, lines, "daily", f"{d:%Y%m%d}", collections_with_jv(d, d)[0])

    reg = sales_register(conf, d)
    section("Sales Register", len(reg), GREEN)
    with st.container(key="card_green_daily_orders"):
        card_title("Sales Register", "Posted invoices dated this day (as Odoo Sale Register Report)", "lines", GREEN)
        show_table(reg, money_cols=REGISTER_MONEY)
        download(reg, "Download sales register", f"sales_register_{d:%Y%m%d}.csv", "dl_daily_orders")


# ================================================================ Monthly Sales Report
def monthly_report():
    section("Monthly Sales Report", None, NAVY)
    months = [p.to_timestamp().date() for p in pd.period_range(DATA_START, month_start, freq="M")[::-1]]
    m = st.selectbox("Report month", months, format_func=lambda x: f"{x:%B %Y} · {fy_label(mis.fy_start(x))}",
                     key="monthly_month")
    next_m = (pd.Timestamp(m) + pd.DateOffset(months=1)).date()
    m_end = min(next_m - timedelta(days=1), today)
    month_coll = collections_with_jv(m, m_end)[0]
    prev_m = (pd.Timestamp(m) - pd.DateOffset(months=1)).date()
    n_days = (m_end - m).days + 1
    is_current = m == month_start
    prev_cmp_end = min(prev_m + timedelta(days=n_days - 1), m - timedelta(days=1))  # same days last month

    o, lines = scoped(prev_m, m_end)
    conf_all = o[o.state.isin(CONFIRMED)]
    conf = conf_all[conf_all.day >= pd.Timestamp(m)]
    prev_conf = conf_all[(conf_all.day >= pd.Timestamp(prev_m)) & (conf_all.day <= pd.Timestamp(prev_cmp_end))]
    quot = open_orders()
    rev, cnt, prev_rev = float(conf.amount.sum()), len(conf), float(prev_conf.amount.sum())

    days = pd.date_range(pd.Timestamp(m), pd.Timestamp(m_end), freq="D")
    daily = conf.groupby("day").agg(Orders=("id", "count"), MT=("mt", "sum"),
                                    Revenue=("amount", "sum")).reindex(days, fill_value=0)
    best = daily.Revenue.idxmax() if rev else None
    cmp_label = "same days last month" if is_current else f"{prev_m:%B %Y}"

    kpi_grid([
        kpi_card("Net Value", money(rev), "bars", NAVY, f"vs {cmp_label} ({money(prev_rev)})", pct_change(rev, prev_rev)),
        kpi_card("Volume", f"{conf.mt.sum():,.2f} MT", "truck", NAVY, f"{prev_conf.mt.sum():,.2f} MT in {cmp_label}",
                 pct_change(float(conf.mt.sum()), float(prev_conf.mt.sum()))),
        kpi_card("Invoices", f"{cnt:,}", "check", NAVY, f"Avg daily sales: {money(rev / n_days)}"),
        kpi_card("Best Day", f"{best:%d %b}" if best is not None else "-", "calendar", NAVY,
                 money(daily.Revenue.max()) if best is not None else "No sales"),
        nr_card(conf, NAVY),
        kpi_card("Open Sales Orders", money(float(quot.amount.sum())), "file", NAVY, f"{len(quot)} approved SOs not delivered · {quot.mt.sum():,.0f} MT · as of now"),
    ])
    if conf.empty:
        st.info(f"No invoices in {m:%B %Y} for the selected filters.")
        return

    section("Day-wise Sales", 2, NAVY)
    with st.container(key="card_navy_monthly_chart"):
        card_title("MT by Zone", f"Invoiced volume per zone, {m:%d} – {m_end:%d %b %Y}"
                   f"{' (to date)' if is_current else ''}", "truck", NAVY)
        zone_mt = conf.groupby("zone").mt.sum().sort_values(ascending=False)
        fig = go.Figure()
        fig.add_bar(x=zone_mt.index, y=zone_mt.values, marker_color=NAVY, text=[f"{v:,.0f}" for v in zone_mt],
                    textposition="outside", cliponaxis=False, hovertemplate="%{x}: %{y:,.2f} MT<extra></extra>")
        st.plotly_chart(style_fig(fig, 380).update_layout(yaxis_title="MT", xaxis_tickangle=-45), width="stretch")
    with st.container(key="card_navy_monthly_table"):
        card_title("Day-wise Table", "Orders, quantity, revenue and running total", "lines", NAVY)
        coll_day = month_coll.groupby(month_coll.date.dt.normalize()).amount.sum().reindex(days, fill_value=0)
        dw = pd.DataFrame({"Date": days.strftime("%d-%m-%Y"), "Day": days.strftime("%a"),
                           "Orders": daily.Orders.astype(int).values, "Total Qty in MT": daily.MT.values,
                           "Revenue": daily.Revenue.values,
                           "Cumulative": daily.Revenue.cumsum().values,
                           "Collection": coll_day.values})
        show_table(dw, money_cols=("Revenue", "Cumulative", "Collection"))
        download(dw, "Download day-wise CSV", f"monthly_sales_{m:%Y_%m}.csv", "dl_monthly_days")

    section("Breakdown", 3, ORANGE)
    breakdowns(conf, lines, "monthly", f"{m:%Y_%m}", month_coll)
    customer_daily(m, m_end)


def collections_with_jv(start: date, end: date):
    """All collection used by the reports: customer receipts (payer taken from the Reference when the receipt has no
    customer) + collection by JV (Miscellaneous entries, Reference "Amount Transfer" + "Cement Supply")
    - customer refunds (Miscellaneous entries, Reference "Customer Refund", negative).
    The Unassigned and Div-7 divisions are left out. Returns (combined, receipts, jv, refunds); page filters applied."""
    receipts = apply_filters(load_collections(start, end))
    jv = apply_filters(load_jv_collections(start, end))
    refunds = apply_filters(load_customer_refunds(start, end))
    receipts = mis.identify_from_reference(receipts, load_customers())
    receipts, jv, refunds = (mis.exclude_divisions(x) for x in (receipts, jv, refunds))  # no Unassigned / Div-7
    keep = ["date", "amount", *odoo_client.CUSTOMER_FIELDS]
    return pd.concat([receipts[keep], jv[keep], refunds[keep]], ignore_index=True), receipts, jv, refunds


def customer_daily(m: date, m_end: date):
    """Customer-wise daily sales (MT) and daily collection for the month, as the workbook's SALES / COLLECTION."""
    reg = register_between(m, m_end)
    coll, receipts, jv, refunds = collections_with_jv(m, m_end)
    cust = mis.customer_frame(apply_filters(load_customers()), apply_filters(load_targets(m, m)), reg, coll)
    section("Customer Wise Daily Sales & Collection", 2, GREEN)
    tabs_ = st.tabs(["Customer Wise Daily Sales", "Customer Wise Daily Collection"])
    with tabs_[0]:
        df = mis.day_pivot(reg, "invoice_date", "mt", m_end, cust)
        st.caption(f"Daily sales (MT) per customer, {m:%B %Y} · total {df.Total.sum():,.2f} MT")
        grid(df, dec_cols=list(df.columns[3:]))
        download(df, "Download CSV", f"customer_daily_sales_{m:%Y_%m}.csv", "dl_monthly_cust_sales")
    with tabs_[1]:
        df = mis.day_pivot(coll, "date", "amount", m_end, cust)
        st.caption(f"Daily collections per customer, {m:%B %Y} · total {money(df.Total.sum())} = customer receipts "
                   f"{money(float(receipts.amount.sum()))} + collection by JV {money(float(jv.amount.sum()))} "
                   f"(Reference \"Amount Transfer\" + \"Cement Supply\") − customer refunds "
                   f"{money(float(-refunds.amount.sum()))} (Reference \"Customer Refund\")")
        grid(df, money_cols=list(df.columns[3:]))
        download(df, "Download CSV", f"customer_daily_collection_{m:%Y_%m}.csv", "dl_monthly_cust_coll")


# ================================================================ YTD Sales Report
def ytd_report():
    section("YTD Sales Report", None, NAVY)
    fys = [date(y, 4, 1) for y in range(year_start.year, DATA_START.year - 1, -1)]
    start = st.selectbox("Financial year (April – March)", fys, key="ytd_year",
                         format_func=lambda f: f"{fy_label(f)} (Apr – {today:%d %b})" if f == year_start
                         else f"{fy_label(f)} (full year)")
    end = today if start == year_start else date(start.year + 1, 3, 31)
    ly_start = date(start.year - 1, 4, 1)
    ly_end = end.replace(year=end.year - 1) if not (end.month == 2 and end.day == 29) else date(end.year - 1, 2, 28)
    has_ly = ly_start >= DATA_START  # no comparison year before the dashboard's first FY
    fy, ly_fy = fy_label(start), fy_label(ly_start)

    o, lines = scoped(ly_start if has_ly else start, end)
    conf_all = o[o.state.isin(CONFIRMED)]
    conf = conf_all[conf_all.day >= pd.Timestamp(start)]
    ly = conf_all[conf_all.day <= pd.Timestamp(ly_end)] if has_ly else conf_all.iloc[0:0]
    quot = open_orders()
    ytd_coll = collections_with_jv(start, end)[0]
    rev, cnt, ly_rev = float(conf.amount.sum()), len(conf), float(ly.amount.sum())

    periods = pd.period_range(start, end, freq="M")
    monthly = conf.groupby(conf.day.dt.to_period("M")).agg(
        Orders=("id", "count"), MT=("mt", "sum"), Revenue=("amount", "sum")).reindex(periods, fill_value=0)
    ly_monthly = ly.groupby(ly.day.dt.to_period("M") + 12).amount.sum().reindex(periods, fill_value=0)
    best_m = monthly.Revenue.idxmax() if rev else None
    month_names = [p.strftime("%b %Y") for p in periods]
    no_ly = f"No data before {DATA_START:%b %Y}"

    kpi_grid([
        kpi_card("FYTD Net Value", money(rev), "trend", NAVY,
                 f"vs same period {ly_fy} ({money(ly_rev)})" if has_ly else no_ly, pct_change(rev, ly_rev)),
        kpi_card("FYTD Volume", f"{conf.mt.sum():,.2f} MT", "truck", NAVY,
                 f"{ly.mt.sum():,.2f} MT same period {ly_fy}" if has_ly else no_ly,
                 pct_change(float(conf.mt.sum()), float(ly.mt.sum()))),
        kpi_card("Invoices", f"{cnt:,}", "check", NAVY, f"Avg monthly sales: {money(rev / len(periods))}"),
        kpi_card("Best Month", best_m.strftime("%B %Y") if best_m is not None else "-", "calendar", NAVY,
                 money(monthly.Revenue.max()) if best_m is not None else "No sales"),
        nr_card(conf, NAVY),
        kpi_card("Open Sales Orders", money(float(quot.amount.sum())), "file", NAVY, f"{len(quot)} approved SOs not delivered · {quot.mt.sum():,.0f} MT · as of now"),
    ])
    if conf.empty:
        st.info(f"No invoices in {fy} for the selected filters.")
        return

    section("Month-wise Sales", 2, NAVY)
    with st.container(key="card_navy_ytd_chart"):
        card_title("MT by Zone", f"Invoiced volume per zone, {fy} ({start:%d %b %Y} – {end:%d %b %Y})", "truck", NAVY)
        zone_mt = conf.groupby("zone").mt.sum().sort_values(ascending=False)
        fig = go.Figure()
        fig.add_bar(x=zone_mt.index, y=zone_mt.values, marker_color=NAVY, text=[f"{v:,.0f}" for v in zone_mt],
                    textposition="outside", cliponaxis=False, hovertemplate="%{x}: %{y:,.2f} MT<extra></extra>")
        st.plotly_chart(style_fig(fig, 380).update_layout(yaxis_title="MT", xaxis_tickangle=-45), width="stretch")
    with st.container(key="card_navy_ytd_table"):
        card_title("Month-wise Table", "Quantity, revenue, growth vs last year and running total" if has_ly
                   else "Quantity, revenue and running total", "lines", NAVY)
        mw = pd.DataFrame({
            "Month": month_names, "Orders": monthly.Orders.astype(int).values, "Total Qty in MT": monthly.MT.values,
            "Revenue": monthly.Revenue.values,
            "Avg Order": (monthly.Revenue / monthly.Orders.where(monthly.Orders > 0)).values,
        })
        money_cols = ["Revenue", "Avg Order", "Cumulative"]
        if has_ly:
            mw[f"{ly_fy} Revenue"] = ly_monthly.values
            mw["Growth %"] = ((monthly.Revenue - ly_monthly) / ly_monthly.where(ly_monthly > 0) * 100).values
            money_cols.append(f"{ly_fy} Revenue")
        mw["Cumulative"] = monthly.Revenue.cumsum().values
        mw["Collection"] = ytd_coll.groupby(ytd_coll.date.dt.to_period("M")).amount.sum().reindex(periods, fill_value=0).values
        money_cols.append("Collection")
        show_table(mw, money_cols=tuple(money_cols), pct_cols=("Growth %",) if has_ly else (),
                   int_cols=("Total Qty in MT",))
        download(mw, "Download month-wise CSV", f"ytd_sales_{fy.replace(' ', '_')}.csv", "dl_ytd_months")

    section("Breakdown", 3, ORANGE)
    breakdowns(conf, lines, "ytd", fy.replace(" ", "_"), ytd_coll)


# ================================================================ MIS Sales Report (one sub-tab per workbook sheet)
def register_between(start: date, end: date) -> pd.DataFrame:
    """Filtered Sales Register lines with invoice date in [start, end]; reuses the main load when it covers it."""
    start = max(start, DATA_START)
    if fetch_start <= start and end <= fetch_end:
        reg = register_all
    else:
        _, _, reg, _ = load(start, end)
    reg = apply_filters(reg)
    dt = pd.to_datetime(reg.invoice_date)
    return reg[(dt >= pd.Timestamp(start)) & (dt <= pd.Timestamp(end))].assign(invoice_date=dt)


def grid(df: pd.DataFrame, dec_cols=(), money_cols=(), pct_cols=(), height=520):
    """Large sheet as an interactive (sortable, searchable) grid."""
    cfg = {c: st.column_config.NumberColumn(format="%.2f") for c in dec_cols}
    cfg |= {c: st.column_config.NumberColumn(format="localized") for c in money_cols}
    cfg |= {c: st.column_config.NumberColumn(format="%.1f%%") for c in pct_cols}
    st.dataframe(df, column_config=cfg, hide_index=True, width="stretch", height=height)


def workbook(sheets: dict) -> bytes:
    from io import BytesIO
    buf = BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for name, df in sheets.items():
            df.to_excel(xw, sheet_name=name[:31], index=False)
            ws = xw.sheets[name[:31]]
            ws.freeze_panes = "A2"
            for i, c in enumerate(df.columns, 1):
                ws.column_dimensions[ws.cell(1, i).column_letter].width = min(45, max(10, len(str(c)) + 2))
    return buf.getvalue()


# ================================================================ Budget vs Actual (MTD)
def budget_tab():
    section("Budget vs Actual (MTD)", None, NAVY)
    c_date, c_note = st.columns([1, 3], vertical_alignment="bottom")
    d = c_date.date_input("Report date (MTD up to)", value=today, min_value=DATA_START, max_value=today,
                          format="DD/MM/YYYY", key="bva_date")
    mf = mis.month_facts(d)
    c_note.caption(f"Budget = approved Odoo Sales Target (MT) for {mf['start']:%B %Y}, prorated to day {mf['elapsed']} "
                   f"of {mf['days']} · Actual = invoiced MT {mf['start']:%d %b} – {d:%d %b %Y} · division, zone, "
                   f"salesperson from the Odoo customer registration · page filters apply")
    targets = apply_filters(load_targets(mf["start"], mf["start"]))
    mtd = register_between(mf["start"], d)
    ratio = lambda num, den: (lambda x: x[num].sum() / x[den].sum() * 100 if x[den].sum() else float("nan"))
    views = (("By Division", "team"), ("By Zone", "zone"), ("By Sales Person", "salesperson"),
             ("By Customer", "customer"), ("By Sales Person-Dealer", "sp_dealer"))
    sp_dealer_cols = ["Salesperson", "Customer Code", "Customer", "Month Target (MT)", "MTD Actual (MT)", "Ach (Month) %"]
    for tab, (label, by) in zip(st.tabs([v[0] for v in views]), views):
        with tab:
            df = mis.budget_vs_actual(targets, mtd, d, by)
            name = mis.BVA_LABELS.get(by, "Customer")
            pro_col, pro_label = ("Month Target (MT)", "Month target") if by == "sp_dealer" else ("Prorated Target", "Prorated budget")
            with st.container(key=f"card_orange_bva_{by}"):
                card_title(f"Budget vs Actual {label.lower()}", f"MT · {len(df)} rows · prorated to day "
                           f"{mf['elapsed']} of {mf['days']}", "bars", ORANGE)
                t = df.groupby(name, as_index=False)[["Month Target (MT)", "Prorated Target", "MTD Actual (MT)"]].sum()
                t = t.sort_values("Month Target (MT)").tail(25)  # chart: the 25 largest budgets
                fig = go.Figure()
                fig.add_bar(y=t[name], x=t[pro_col], name=pro_label, orientation="h",
                            marker_color="#b8c2cf", hovertemplate=f"%{{y}}: %{{x:,.0f}} MT<extra>{pro_label}</extra>")
                fig.add_bar(y=t[name], x=t["MTD Actual (MT)"], name="MTD actual", orientation="h",
                            marker_color=ORANGE, hovertemplate="%{y}: %{x:,.2f} MT<extra>MTD actual</extra>")
                st.plotly_chart(style_fig(fig, max(300, 30 * len(t))).update_layout(barmode="group", xaxis_title="MT"),
                                width="stretch", key=f"bva_chart_{by}")
                if by == "sp_dealer":  # salesperson -> dealer, only month target / MTD actual / month achievement
                    df = df[sp_dealer_cols]
                if by in ("customer", "sp_dealer") and len(df) > len(t):
                    st.caption(f"Chart shows the {len(t)} customers with the largest budget; the table lists all {len(df)}.")
                show_table(df, dec_cols=[c for c in df.columns if c.endswith(("(MT)", "Target", "Prorated", "DRR", "ARR"))],
                           total_fns={"Ach (Prorated) %": ratio("MTD Actual (MT)", "Prorated Target"),
                                      "Ach (Month) %": ratio("MTD Actual (MT)", "Month Target (MT)"),
                                      "Projected Ach %": ratio("Projected (MT)", "Month Target (MT)")})
            download(df, "Download CSV", f"budget_vs_actual_{by}_{d:%Y%m%d}.csv", f"dl_bva_{by}")


def div_zone_display(df: pd.DataFrame) -> pd.DataFrame:
    """Workbook look: whole numbers (MT and TZS), '-' for zero, % without decimals, shortfall in brackets."""
    def num(v, dec=0):
        return "-" if pd.isna(v) or round(v, dec) == 0 else f"{v:,.{dec}f}"

    out = df.copy().astype(object)
    for c in df.columns[2:]:
        if c.startswith("%"):
            out[c] = df[c].map(lambda v: "-" if pd.isna(v) else f"{v:,.0f}%")
        elif c == "Prorated TGT Shortfall":
            out[c] = df[c].map(lambda v: "-" if pd.isna(v) or round(v) == 0
                               else f"({abs(v):,.0f})" if v < 0 else f"{v:,.0f}")
        else:
            out[c] = df[c].map(num)
    return out


def mis_report():
    section("MIS Sales Report", None, NAVY)
    c_date, c_note = st.columns([1, 3], vertical_alignment="bottom")
    d = c_date.date_input("Report date (MTD up to)", value=today, max_value=today, format="DD/MM/YYYY", min_value=DATA_START,
                          key="mis_date")
    mf = mis.month_facts(d)
    m_start, fy = mf["start"], mis.fy_start(d)
    lm_start = (pd.Timestamp(m_start) - pd.DateOffset(months=1)).date()
    lm_end = m_start - timedelta(days=1)
    c_note.caption(f"Month {m_start:%B %Y}: day {mf['elapsed']} of {mf['days']} ({mf['remaining']} remaining) · "
                   f"financial year from {fy:%d %b %Y} · all figures from Odoo · page filters apply")

    reg_all = register_between(min(fy, lm_start), d)
    mtd = reg_all[reg_all.invoice_date >= pd.Timestamp(m_start)]
    ftd = mtd[mtd.invoice_date == pd.Timestamp(d)]
    lm = reg_all[(reg_all.invoice_date >= pd.Timestamp(lm_start)) & (reg_all.invoice_date <= pd.Timestamp(lm_end))]
    reg_fy = reg_all[reg_all.invoice_date >= pd.Timestamp(fy)]
    targets = apply_filters(load_targets(m_start, m_start))
    coll_fy, receipts_fy, jv_fy, refunds_fy = collections_with_jv(fy, d)  # receipts + collection by JV - customer refunds
    coll_mtd = coll_fy[coll_fy.date >= pd.Timestamp(m_start)]
    jv_mtd = jv_fy[jv_fy.date >= pd.Timestamp(m_start)]
    refunds_mtd = refunds_fy[refunds_fy.date >= pd.Timestamp(m_start)]
    customers = apply_filters(load_customers())
    cust = mis.customer_frame(customers, targets, mtd, lm, coll_mtd)
    disc_mt = VOLUME_DISCOUNT_PER_BAG * 20

    mt, tgt = float(mtd.mt.sum()), float(targets.target.sum())
    pro = tgt / mf["days"] * mf["elapsed"]
    kpi_grid([
        kpi_card(f"FTD {d:%d %b}", f"{ftd.mt.sum():,.2f} MT", "home", NAVY, f"{ftd.invoice_id.nunique()} invoices"),
        kpi_card("MTD Sales", f"{mt:,.2f} MT", "truck", NAVY, f"Last month {lm.mt.sum():,.2f} MT"),
        kpi_card("Sales Target", f"{tgt:,.0f} MT", "check", NAVY, f"Prorated {pro:,.0f} MT to day {mf['elapsed']}"),
        kpi_card("Achievement", f"{mt / pro * 100:.1f}%" if pro else "-", "trend", ORANGE,
                 f"{mt / tgt * 100:.1f}% of month target" if tgt else "No target"),
        kpi_card("MTD Collection", money(float(coll_mtd.amount.sum())), "receipt", ORANGE,
                 f"{len(coll_mtd) - len(jv_mtd) - len(refunds_mtd)} receipts + {money(float(jv_mtd.amount.sum()))} by JV"
                 f" − {money(float(-refunds_mtd.amount.sum()))} refunds"),
    ])

    sheets = {}
    tabs_ = st.tabs(["Sale Realization Summary", "Division Wise Sales -Collection Summary", "Dealer Wise Dashboard",
                     "Customer Wise YTD Sales", "MTD Sales Register", "Exemption-Certificate report",
                     "Sales vs Target", "Collection By JV"])
    tag = f"{d:%Y%m%d}"

    with tabs_[4]:
        df = mis.register_sheet(mtd, disc_mt, NCR_RATE)
        sheets[f"{m_start:%b}".upper() + " SALE REGISTER"] = df
        st.caption(f"{len(df)} lines · {df['Invoice No'].nunique()} invoices · {df['Qty MT'].sum():,.2f} MT · "
                   f"Net Value {money(df['Net Value'].sum())} · Net Realisation {money(df['Net Realisation'].sum())}")
        grid(df, dec_cols=("Qty (bags)", "Qty MT", "NCR / MT", f"NCR @ {NCR_RATE:g}"),
             money_cols=("Unit Rate w/o VAT", "Net Value", "VAT", "Invoice Value", "Excise", "Freight",
                         "Net Realisation", "Volume Discount"))
        download(df, "Download register CSV", f"sale_register_{tag}.csv", "dl_mis_reg")

    with tabs_[0]:
        by_type, by_grade, by_dl = mis.sr_summary(mtd, disc_mt, NCR_RATE)
        sheets[f"{m_start:%b}".upper() + " SR SUMMARY"] = by_type
        with st.container(key="card_navy_mis_srtype"):
            card_title("Summary by Type", f"Volume discount = trade MT × TZS {VOLUME_DISCOUNT_PER_BAG:g}/bag · "
                       f"NCR = (net realisation − volume discount) / MT / {NCR_RATE:g}", "lines", NAVY)
            ncr = f"NCR @ {NCR_RATE:g}"
            show_table(by_type, money_cols=("Net Realisation", "NR less Volume Discount", "Freight", "Volume Discount"),
                       dec_cols=("Qty MT", ncr), first_col_right=True,
                       total_fns={ncr: lambda t: t["NR less Volume Discount"].sum() / t["Qty MT"].sum() / NCR_RATE
                                  if t["Qty MT"].sum() else float("nan")})
        with st.container(key="card_green_mis_grade"):
            card_title("By Grade", "MT and share per cement grade", "bars", GREEN)
            show_table(by_grade, dec_cols=("Qty MT",))
        with st.container(key="card_green_mis_dl"):
            card_title("Delivered vs Ex Works", "MT and share per delivery type", "truck", GREEN)
            show_table(by_dl, dec_cols=("Qty MT",))
        st.caption(f"Collection MTD: {money(float(coll_mtd.amount.sum()))} (posted customer receipts + collection by JV "
                   f"{money(float(jv_mtd.amount.sum()))} − customer refunds {money(float(-refunds_mtd.amount.sum()))}).")

    with tabs_[1]:
        df = mis.div_zone(targets, mtd, ftd, lm, coll_mtd, d, coll_fy)
        sheets["TOTAL DIV WISE"] = df
        strong = [i for i, v in enumerate(df.Division) if v.startswith(("Total", "Grand", "Exports"))]
        with st.container(key="card_navy_mis_div"):
            card_title("Division Wise Sales -Collection Summary", "MT by division and zone (customer registration) · Potential is "
                       "not kept in Odoo", "lines", NAVY)
            show_table(div_zone_display(df), total=False, strong_rows=strong, first_col_right=True,
                       right_cols=tuple(df.columns[2:]))
        download(df, "Download CSV", f"division_wise_{tag}.csv", "dl_mis_div")

    with tabs_[2]:
        df = mis.dealer_dashboard(cust, targets, mtd, lm, coll_mtd, d)
        sheets["DEALER DASH BOARD"] = df
        st.caption(f"{len(df)} customers with a target, sales or collection · target {df['Target (MT)'].sum():,.0f} MT · "
                   f"actual {df['Actual MTD (MT)'].sum():,.2f} MT · collection {money(df['Collection MTD'].sum())}")
        grid(df, dec_cols=("Target (MT)", "Prorated Target", "Actual MTD (MT)", "Last Month (MT)", "Diff from Target",
                           "Diff from LM"), money_cols=("Collection MTD",), pct_cols=("% of Target",))
        download(df, "Download CSV", f"dealer_dashboard_{tag}.csv", "dl_mis_dealer")

    with tabs_[6]:
        df = mis.sales_vs_target(cust, targets, mtd)
        sheets["Total sales & tgt"] = df
        st.caption(f"Sales {m_start:%b %Y} vs Odoo Sales Target · {len(df)} customers")
        grid(df, dec_cols=("Sales MTD (MT)", "Target (MT)"), pct_cols=("% Target",))
        download(df, "Download CSV", f"sales_vs_target_{tag}.csv", "dl_mis_svt")

    with tabs_[3]:
        df = mis.ytd_pivot(reg_fy, d, cust)
        sheets["YTD SALES"] = df
        st.caption(f"Month-wise sales (MT) per customer since {fy:%d %b %Y} · total {df.Total.sum():,.2f} MT")
        grid(df, dec_cols=list(df.columns[4:]))
        download(df, "Download CSV", f"ytd_sales_{tag}.csv", "dl_mis_ytd")

    with tabs_[5]:
        ex = load_exemptions(d)
        if sel_cust:
            ex = ex[ex.customer.isin(sel_cust)]
        df = mis.exemption_sheet(ex, d)
        sheets["EXEMPTION"] = df
        st.caption("VAT exemption certificates valid on/after the report date · Invoiced Qty = MT on posted invoices "
                   "with the certificate's proforma")
        grid(df, dec_cols=("Certificate Qty (MT)", "Invoiced Qty (MT)", "Balance Qty (MT)"), height=420)
        download(df, "Download CSV", f"exemption_{tag}.csv", "dl_mis_ex")

    with tabs_[7]:
        jv = jv_fy
        months = pd.period_range(pd.Timestamp(fy), pd.Timestamp(d), freq="M")
        jv = jv.assign(month=jv.date.dt.to_period("M"))
        by_cust = jv.pivot_table(index=["customer", "customer_code", "salesperson", "team", "zone"], columns="month",
                                 values="amount", aggfunc="sum", fill_value=0.0).reindex(columns=months, fill_value=0.0)
        by_cust.columns = [p.strftime("%b %Y") for p in by_cust.columns]
        by_cust["Total"] = by_cust.sum(axis=1)
        by_cust = by_cust.reset_index().rename(columns={"customer": "Customer", "customer_code": "Customer Code",
                                                        "salesperson": "Salesperson", "team": "Division", "zone": "Zone"})
        by_cust = by_cust.sort_values("Total", ascending=False).reset_index(drop=True)
        detail = pd.DataFrame({"Date": jv.date.dt.strftime("%d-%m-%Y"), "JV No": jv.jv, "Customer": jv.customer,
                               "Customer Code": jv.customer_code, "Salesperson": jv.salesperson, "Division": jv.team,
                               "Zone": jv.zone, "Amount Transfer": jv.amount, "Reference": jv.reference})
        sheets["COLLECTION BY JV"] = by_cust
        sheets["COLLECTION BY JV DETAIL"] = detail
        kpi_grid([
            kpi_card("Collection By JV", money(float(jv.amount.sum())), "receipt", ORANGE,
                     f"{fy:%d %b %Y} to {d:%d %b %Y}"),
            kpi_card("Journal Entries", f"{jv.jv.nunique():,}", "lines", NAVY, "Miscellaneous · Reference \"Amount Transfer\" + \"Cement Supply\""),
            kpi_card("Customers", f"{jv.customer.nunique():,}", "home", NAVY, "with a JV collection"),
        ])
        with st.container(key="card_navy_mis_jv"):
            card_title("Collection By JV - Customer Wise",
                       "Accounting › Journal Entries › Miscellaneous, Reference containing \"Amount Transfer\" and \"Cement Supply\" · amount credited "
                       f"to the customer's receivable account (TZS), month-wise from {fy:%B %Y}", "receipt", NAVY)
            month_cols = [c for c in by_cust.columns if c not in ("Customer", "Customer Code", "Salesperson", "Division", "Zone")]
            show_table(by_cust, int_cols=tuple(month_cols), first_col_right=True)
            download(by_cust, "Download CSV", f"collection_by_jv_{tag}.csv", "dl_mis_jv")
        with st.container(key="card_green_mis_jvdetail"):
            card_title("Journal Entry Detail", "One line per journal entry and customer", "lines", GREEN)
            grid(detail, money_cols=("Amount Transfer",), height=420)
            download(detail, "Download detail CSV", f"collection_by_jv_detail_{tag}.csv", "dl_mis_jv_detail")

    if USER["downloads"]:
        st.download_button("⬇ Download full MIS workbook (.xlsx, all sheets)", workbook(sheets),
                           file_name=f"SALES REPORT {d:%d %B %Y}.xlsx".upper().replace(".XLSX", ".xlsx"),
                           mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", key="dl_mis_xlsx",
                           type="primary")


# ================================================================ tabs
TABS = {"dashboard": ("📊  Dashboard", dashboard_tab), "daily": ("📅  Daily Sales Report", daily_report),
        "monthly": ("🗓️  Monthly Sales Report", monthly_report), "ytd": ("📈  YTD Sales Report", ytd_report),
        "budget": ("🎯  Budget vs Actual (MTD)", budget_tab),
        "mis": ("📑  MIS Sales Report", mis_report)}
allowed = [TABS[k] for k in USER["tabs"]]
if SCOPE:
    st.caption("Showing " + " · ".join(f"{k.title()}: {', '.join(v)}" for k, v in SCOPE.items()) + " only")
tabs = st.tabs([label for label, _ in allowed])
for tab, (_, render) in zip(tabs, allowed):
    with tab:
        try:
            render()
        except odoo_client.OdooError as e:
            st.error(f"**Odoo is unreachable.**\n\n{e}")

st.caption(f"Source: Odoo Sale Register (posted customer invoices, by invoice date). Revenue = Net Value (untaxed, "
           f"incl. excise). Salesperson, division, zone and region from customer registration. "
           f"Last updated {fetched_at:%d %b %Y, %H:%M:%S}.")
if st.session_state.get("odoo_error") and not odoo_error:  # a report further down fell back to older data
    st.warning("Odoo became unreachable while loading some reports - they show the last successful data. "
               f"Retrying automatically.\n\n{st.session_state['odoo_error']}")
