> **SUPERSEDED 2026-10-08 — do not send.** Odoo delivered this as a reshape of
> `sale_dashboard_report` before it went out. Two things below were also wrong:
> the Register is filtered by **invoice date**, not DN date (462.9 MT of the
> September Register was delivered in August), and the 30 MT on CEMENT 32.5 is
> credit note CRN/2026/09/00052, not a month-boundary item. See draft 05.

# Draft mail — please expose the Sale Register as an API endpoint

**To:** Odoo Development / Admin Team
**Cc:** Sales Manager · Plant Head · IT Head
**From:** IT / MIS
**Subject:** Sale Register — request for an API endpoint (`sale_register_report`)

---

Dear Team,

We have found why the Sales figure on our dashboard does not agree with the Sale Register, and we would like to request one endpoint to close it for good.

**The problem**

`sale_dashboard_report` returns `sale_orders` and `sale_order_lines`. We total those lines to get monthly sales tonnage. That is **ordered** tonnage, not **delivered** tonnage, so it does not match the Sale Register the Sales team works from.

For **September 2026** we measured the gap:

| Source | September 2026 MT |
| --- | --- |
| Sale Register (`SEP SALE REGISTER`, Grand MT) | **59,548.76** |
| `sale_dashboard_report` → `sale_order_lines` | 60,764.1 |
| Difference | **+1,215.3 MT (2.0% overstated)** |

**The cause is timing, not data quality.** Taking the Sale Register's own rows and grouping the same tonnage two ways:

| Grouped by | Jun 2026 | Jul 2026 | Aug 2026 | Sep 2026 |
| --- | --- | --- | --- | --- |
| **Delivery Note date** | — | — | 462.9 | 59,085.9 |
| **Sale Order date** | 46.0 | 100.0 | 5,113.1 | 54,289.6 |

Cement ordered in August is delivered in September, and cement ordered in September is delivered in October. Counting by order date therefore puts tonnage in the wrong month in both directions. No change to the sale-order data would fix this — the two are simply different events.

**What we verified in the meantime**

Your `dispatch_report` endpoint is very close to the Register. Comparing September grade by grade:

| Grade | Sale Register | `dispatch_report` | Difference |
| --- | --- | --- | --- |
| CEMENT 42.5 R | 43,769.9 | 43,769.9 | 0.0 |
| CEMENT B-M 42.5 N | 9,633.5 | 9,633.5 | 0.0 |
| CEMENT OPC 42.5 N | 995.4 | 995.4 | 0.0 |
| CEMENT 32.5 | 5,150.0 | 5,180.0 | +30.0 |
| **Cement total** | **59,548.8** | **59,578.8** | **+30.0 (0.05%)** |

Three of the four grades match exactly. We are re-pointing our tonnage figures to `dispatch_report` now, so the headline number will reconcile with the Register from this week.

Two small questions on that 30 MT, purely so we can label it correctly:

1. Is the 30 MT difference on **CEMENT 32.5** a delivery note that falls on the month boundary (dispatched 30 Sep, invoiced 1 Oct, or similar)? We are not asking anyone to adjust anything — we only want to know whether to expect a small timing variance each month.
2. `dispatch_report` also returns **SCRAP STEEL** and **FLY ASH** rows. We exclude them, because the Sale Register is cement-only. Please confirm that is correct.

**What we are requesting**

`dispatch_report` gives correct tonnage, but it returns only `dispatch_date`, `product_grade`, `dispatch_channel` and `quantity_dispatched_mt`. It carries **no customer**, so we cannot report sales by customer, division, zone or sales officer on a delivery basis.

The Sale Register already has everything needed. We are asking for it as an endpoint — **`sale_register_report`** — in the same style as `dispatch_report` and `sale_dashboard_report` (form-encoded POST, `api_key` + `from_date` + `to_date` as strict `YYYY-MM-DD`).

One row per delivery note, with these columns from the Register:

| Column on the Register | Why we need it |
| --- | --- |
| `SO NO`, `SO DATE` | join back to the sale order |
| `INV. NO`, `INV DATE` | reconcile against invoiced value |
| **`DN NO`, `DN DATE`** | **the delivery event — this is what makes the figure correct** |
| `CUSTOMER CODE`, `CUSTOMER NAME` | per-customer sales |
| `SEGMENT`, `TYPE`, `SALE TYPE` | Trade / Project / Exempted split |
| `DIVISION`, `ZONE`, `REGION` | per-officer and per-territory achievement |
| `ITEM CODE`, `ITEM DESCRIPTION` | grade mix |
| `UOM`, `Baggage Type`, `QTY(bags)`, **`QTY MT`** | tonnage, bag vs bulk |
| `NET amount without VAT (TZS)`, `VAT (TZs)`, `Invoice Value Total` | sales value |

If it is easier to return the whole Register row set unchanged, that is fine too — extra columns cost us nothing, and we would rather take your existing report as-is than have anyone build a reduced version of it.

**Two notes that will save a round trip**

- **Please filter by `DN DATE`**, not `SO DATE`. That is the whole point of the request: a September call should return what was *delivered* in September, which is how the Register is built.
- **Date format**: strict ISO `YYYY-MM-DD`, as with the other endpoints. We have learned that other formats either return zero rows or fail with a Postgres `datestyle` error.

One more thing worth flagging while we are here: on `sale_dashboard_report`, `customer_receipts` still ignores the date filter — a 2-day window returned 15,826 receipts. We filter it on our side, so nothing is wrong in our reports, but it is still open from our 3 September note.

Thank you — the dispatch and production endpoints have been working well, and this last one would let the Sales dashboard match the Register exactly, including by officer and customer.

Best regards,
IT / MIS
Lake Cement Ltd.
