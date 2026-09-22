# Lake Cement MIS — Purchase Data API Requirements (for Odoo Team)

**Raised:** 2026-09-22 · **Endpoint concerned:** `POST <base>/purchase_dashboard_report`
**Companion doc:** `ODOO_PRODUCTION_API_REQUIREMENTS.md` (same format, different module)

---

## 1. What the report has to show

The MIS Purchase dashboard reports **Open PR** and **Open PO**, each broken
down by the four spend categories already present in your data — Service,
Local, Import, Raw Material — and each on four measures:

| Measure | Meaning |
|---|---|
| No. of PRs / POs | distinct documents still open |
| No. of items | open **order lines** — one PO covering 12 materials is 1 document, 12 items |
| Quantity | quantity still outstanding |
| Value (TZS) | value of the outstanding quantity only, not the whole document |

The business definitions, confirmed with the Purchase & Stores department:

- **Open PR** — requisition **approved**, PO **not yet created** from it.
- **Open PO** — PO **approved**, **GRN not yet made** against it.

Today we can serve **Open PO approximately** and **Open PR not at all**.

---

## 2. What your endpoint already gives us, and what we do with it

Confirmed working on production (`erp.lakecement.co.tz`, database `parallel`):

| Array | Fields we use | Used for |
|---|---|---|
| `purchase_orders` | `purchase_order_id`, `purchase_order`, `vendor`, `order_date`, `total_amount`, `currency`, `status`, `approval_status`, `purchase_type` (`local`/`import`), `po_for_key` (`material`/`service`), `incoming_status` | PO value trend; the Local / Import / Service columns |
| `purchase_order_lines` | `purchase_order_id`, `product_id`, `quantity`, `received_quantity`, `pending_quantity`, `line_amount` | every Open PO measure |
| `products` | `product_id`, `category_id` | mapping a line to a category |
| `product_categories` | `category_id`, `classification` | identifying the Raw Material column |

**This is genuinely useful and we are not asking you to change it.** The
requests below are additions.

---

## 3. What we need — in priority order

### 3.1 Purchase Requisitions (blocks the entire Open PR row) — HIGHEST PRIORITY

The endpoint returns no requisition data of any kind: no PR number, no
requisition record, no link from a PO back to the PR it came from. Every
Open PR cell on the dashboard therefore renders the word "Pending" with an
explanation — the honest thing to show, but it is half the report.

We need requisitions carrying enough to compute *approved but not yet
converted to a PO*:

| Field | Why |
|---|---|
| `purchase_requisition_id`, `purchase_requisition` (the PR number) | identity, and the count of PRs |
| `requisition_date` | period filtering |
| `approval_status` (+ `approval_date` if you hold it) | "approved" is half the definition |
| `state` | to exclude cancelled / rejected |
| `department` or `requested_by` | we expect to break PRs down by department next |
| `purchase_order_id` — **the PO created from this PR, null if none** | this single field is what makes "open" computable. Without it we cannot tell an open PR from a converted one, and no amount of other data substitutes for it. |

…and their lines, as a parallel array keyed by `purchase_requisition_id`:

| Field | Why |
|---|---|
| `product_id` | maps to category, which gives the four columns |
| `quantity`, `uom` | the Quantity measure |
| `estimated_value` or `line_amount` | the Value measure |

If a PR can be **partially** converted (some lines become a PO, others do
not), tell us and put the PO link at **line** level instead — we will
measure it line by line, which is more accurate anyway.

### 3.2 "Open" is a state as of today, not a date-range total — HIGHEST PRIORITY

This is the most important point in this document.

Your endpoint filters everything by `from_date`/`to_date` against the
document date. But a PO raised in **March** that still has no GRN is **open
right now**. Asking for September returns September's documents, so that
March PO is invisible — and what we can show for "Open PO" is really "POs
raised in the selected period that are still open", which is a different
and much smaller number than the one the business is asking for.

Either of these solves it:

- **(a) preferred** — a parameter such as `open_as_of=YYYY-MM-DD` returning
  **all** PRs / POs still open on that date, whatever their document date; or
- **(b)** a flag such as `include_open_before=true` that adds still-open
  documents raised before `from_date` to the normal response.

We will keep the period filter for the trend and for "raised in this period"
figures. We need the open-as-of view **alongside** it, not instead of it.

### 3.3 GRN / receipt records — HIGH PRIORITY

"Open PO" is currently inferred from `pending_quantity > 0`. That is close,
but it is not the definition: it also counts **partially received** POs, and
it cannot see whether the **approval** step was completed.

We need the receipts themselves:

| Field | Why |
|---|---|
| `grn_number` / `picking_name`, `receipt_date`, `state` | to test "GRN not yet made" directly instead of inferring it |
| `purchase_order_id` | to attach a receipt to its PO |
| per-line `product_id`, `received_quantity` | partial receipts |

Also: please confirm the possible values of `approval_status` on
`purchase_orders`, and which of them means "approved". We read the field
today but do not filter on it, because we do not know its vocabulary.

### 3.4 Unit of measure on order lines — MEDIUM PRIORITY

`purchase_order_lines` carries `quantity` and `pending_quantity` but no
`uom`. We report Quantity per category and deliberately never total it
across categories, because the lines mix tonnes, litres, bags and pieces and
a combined figure would be a number with no unit. Send `uom` per line and we
can group and label properly instead of hedging.

### 3.5 Pagination — MEDIUM PRIORITY, rising

Known already; repeated here because the new period filters make it bite.
Large ranges return **truncated, unparseable JSON with HTTP 200**, and there
is no pagination. We work around it by fetching **one calendar month at a
time** and merging, so a year-to-date view costs nine calls. It works, but it
is slow and it multiplies with every user. A `limit`/`offset` pair or a
cursor would let us ask once.

### 3.6 Master data is wrongly date-filtered — LOW PRIORITY, but a correctness trap

`products`, `product_categories`, `stock_quants` and `stock_locations` are
filtered by the date range, so they arrive **incomplete** rather than as
snapshots (241 products for August vs. 291 for July). We only use them to
classify records inside the same range, so it is currently harmless — but it
is a trap for anyone who assumes they are a catalogue. These should ignore
the date filter.

---

## 4. How to deliver it — your call

**Option A — extend `purchase_dashboard_report`.** Add
`purchase_requisitions` and `purchase_requisition_lines` as two more parallel
arrays, plus the `open_as_of` parameter from §3.2. Least work for you, no new
authentication, and our client already handles this response shape.

**Option B — a sibling `purchase_requisition_report` endpoint**, same
transport and API key as the four you have already built. Better if the PR
join is expensive.

Either is fine. We would rather have §3.1 and §3.2 quickly, in whatever form
is easiest for you, than wait for a complete redesign.

## 5. Requirements that apply either way

1. **Form-encoded POST**, as the existing endpoints are — not JSON. The
   documented JSON body does not work against a `type='http'` controller.
2. **Strict ISO `YYYY-MM-DD` dates.** Production already rejects anything
   else with a Postgres datestyle error, so we always send ISO.
3. **Stable field names.** We map them once and test against them.
4. **Null, not zero, for unknown.** A zero is indistinguishable from a real
   zero and we will report it to management as fact.
5. Tell us the **vocabulary of every status field** you send — `state`,
   `approval_status`, `incoming_status`.

## 6. What we are NOT asking for

The **PO List** was removed from this dashboard on 2026-09-22. The purchasing
team reads that list in Odoo itself, and duplicating it here only created a
second place to keep correct. No PO-list data is needed.
