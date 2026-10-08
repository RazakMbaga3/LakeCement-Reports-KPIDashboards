# Draft mail — Sale Register feed: thank you, and five gaps

**To:** Odoo Development / Admin Team
**Cc:** Sales Manager · IT Head
**From:** IT / MIS
**Subject:** `sale_dashboard_report` (new format) — reconciled, five fields still needed

---

Dear Team,

Thank you for the new `sale_dashboard_report`. We have reconciled it against the Sales team's September 2026 Sale Register and it matches invoice by invoice: all 2,003 Register invoices are in the feed, with the same tonnage, and the untaxed amount equals the Register's NET to the shilling. It now feeds the Sales dashboard.

Five things the Sales team reports on are still missing from it. In order of importance:

**1. Credit notes**

The feed returns customer invoices only. The September Register includes one credit note, **CRN/2026/09/00052** (CUS1201, CEMENT 32.5, −30 MT, −8,389,830.51 TZS), and it is the only reason our September total reads 59,578.76 MT against the Register's 59,548.76. Please include posted customer credit notes (refunds) in the same feed, with their own type so we can net them.

**2. Segment, sale type, payment term, delivery type**

These four Register columns are not in the feed, and the Sales team reports by them:

| Register column | September values |
| --- | --- |
| SEGMENT | Dealer, Project Customer |
| SALE TYPE | Cement Domestic Trade / Project / Project Exempted |
| PAYMENT TERM | Advance, Multiple, BG |
| DELIVERY TYPE | Ex Works, Delivered |

They are already on the invoice or its sale order, so this is a matter of adding them to each invoice in the response.

**3. Per-customer targets**

The old feed returned a target line per customer. The new `sales_target` is a single total (103,000 for any date range), and it does not match the Sales team's September target sheet (104,381 MT across 755 customers). Please return the per-customer target rows for the month as before (customer, salesperson, division, zone, target quantity). Officer achievement cannot be shown without them.

**4. Receipts by receipt date**

Each invoice carries the receipts applied to it, which is right. But the Sales team's monthly "Collection" (21.16 billion for September) is all cash received in the month, including receipts that pay older invoices and advances not yet invoiced. Those cannot be found through this month's invoices. A separate list of customer receipts filtered by **receipt date** would answer it. (The old `customer_receipts` ignored the date filter entirely, so please test the filter.)

**5. Due date**

`invoice_date_due` on each invoice, so outstanding can be aged as days overdue rather than days since invoicing.

**Two notes on the feed as it is**

- **Speed:** about 0.27 seconds per invoice, so a full month (~2,000 invoices) takes about 9 minutes and times out at 180 s. We work around it by pulling one day at a time, every 30 minutes. If there is a quick index or query change on your side, it would let us backfill history faster, but it is not blocking.
- **Availability:** twice this afternoon (8 Oct) the endpoint returned `502` / dropped connections for a few minutes, then recovered. Our sync retries, so nothing was lost. We mention it in case it lines up with something on your side.

Thank you again — this one change fixed the main discrepancy the Sales Manager raised.

Best regards,
IT / MIS
Lake Cement Ltd.
