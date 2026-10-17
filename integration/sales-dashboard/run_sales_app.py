"""Start the Sales Dashboard without its own sign-in form.

nginx already refuses every /sales-app/ request unless the browser holds the
cookie issued to a signed-in MD / Management / Sales user of the MIS
(deploy/nginx-sales-app.conf), and Streamlit listens on 127.0.0.1 only. So a
second User ID / Password form adds nothing but a second password to remember.

When SALES_APP_AUTO_USER names a user in users.toml, this launcher makes the
vendored auth.require_login() sign that user in silently. auth.py itself stays
byte-for-byte the collaborator's copy. Unset it and the form comes back.

Usage (pm2 does this):  python run_sales_app.py run app.py --server...
"""
import os
import sys

import streamlit as st

import auth

_original_require_login = auth.require_login


def _require_login(brand_html, company):
    if "user" in st.session_state:
        return st.session_state["user"]
    uid = os.environ.get("SALES_APP_AUTO_USER", "").strip().lower()
    users = auth.load_users()
    if uid and uid in users:
        st.session_state["user"] = auth._session_user(uid, users[uid])
        return st.session_state["user"]
    return _original_require_login(brand_html, company)


auth.require_login = _require_login

if __name__ == "__main__":
    from streamlit.web.cli import main
    sys.argv = ["streamlit"] + sys.argv[1:]
    main()
