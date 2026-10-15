"""Login and access levels for the dashboard.

Users live in users.toml (next to app.py, never committed). Each user has:
    name, level        shown in the header
    password           pbkdf2_sha256$<iterations>$<salt hex>$<hash hex>  (see hash_password)
    tabs               tab keys the user may open, or ["all"]
    downloads          CSV / Excel download buttons
    refresh            "Refresh now" button (reloads everything from Odoo)
    [scope]            data restriction by customer-registration group, e.g. team = ["D1"], zone = ["Dodoma"],
                       salesperson = ["..."]; empty = all data. Scoped users never see the MIS report.
"""
import hashlib
import hmac
import secrets
import time
import tomllib
from pathlib import Path

import streamlit as st

USERS_FILE = Path(__file__).with_name("users.toml")
TAB_KEYS = ("dashboard", "daily", "monthly", "ytd", "budget", "mis")
SCOPE_FIELDS = ("team", "zone", "region", "salesperson", "customer")
ITERATIONS = 200_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${digest.hex()}"


def _check(password: str, stored: str) -> bool:
    try:
        algo, iters, salt, digest = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    calc = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iters))
    return hmac.compare_digest(calc.hex(), digest)


def load_users() -> dict:
    if not USERS_FILE.exists():
        return {}
    with USERS_FILE.open("rb") as f:
        return tomllib.load(f).get("users", {})


def _session_user(uid: str, u: dict) -> dict:
    scope = {k: list(v) for k, v in (u.get("scope") or {}).items() if k in SCOPE_FIELDS and v}
    tabs = list(TAB_KEYS) if "all" in u.get("tabs", []) else [t for t in TAB_KEYS if t in u.get("tabs", [])]
    if scope:  # the MIS workbook (collections, exemptions, all-customer sheets) is company-wide only
        tabs = [t for t in tabs if t != "mis"]
    return {"id": uid, "name": u.get("name", uid), "level": u.get("level", ""), "tabs": tabs or ["dashboard"],
            "downloads": bool(u.get("downloads", False)), "refresh": bool(u.get("refresh", False)), "scope": scope}


def require_login(brand_html: str, company: str) -> dict:
    """Return the signed-in user; otherwise show the login form and stop the script."""
    if "user" in st.session_state:
        return st.session_state["user"]
    users = load_users()
    _, mid, _ = st.columns([1, 1.1, 1])
    with mid, st.container(key="login_box"):
        st.markdown(f'<div class="lc-login-head">{brand_html}<div><b>{company}</b>'
                    f'<div class="sub">Sales Dashboard · sign in</div></div></div>', unsafe_allow_html=True)
        if not users:
            st.error("No users configured (users.toml is missing). Ask the administrator.")
            st.stop()
        with st.form("login", border=False):
            uid = st.text_input("User ID").strip().lower()
            pwd = st.text_input("Password", type="password")
            ok = st.form_submit_button("Sign in", type="primary", width="stretch")
        if ok:
            u = users.get(uid)
            if u and _check(pwd, u.get("password", "")):
                st.session_state["user"] = _session_user(uid, u)
                st.rerun()
            time.sleep(1.5)  # slow down password guessing
            st.error("Wrong user ID or password.")
    st.stop()


def logout():
    st.session_state.pop("user", None)
    st.rerun()
