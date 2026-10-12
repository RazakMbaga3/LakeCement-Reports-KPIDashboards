# Draft mail — fields on the Production Entry form that the API leaves out

**To:** Odoo Development / Admin Team
**Cc:** Plant Head · IT Head
**From:** IT / MIS
**Subject:** `production_report` — please return the fields already on the Production Entry form

---

Dear Team,

`production_report` is working well and we are pulling from it every 30 minutes. Thank you.

One gap: several fields shown on the Production Entry form view are not in the API response. We are not asking you to capture anything new — the values are already stored on the records. We are asking for them to be included in the payload.

**Example — CLK/2026/00173, 28/09/2026 (Clinker Production)**

The form view shows these. The API returns none of them:

| Field on the form | Value on that entry |
| --- | --- |
| Coal NCV (KCAL/KG) | 5,488.00 |
| Running Hours | 20:18 |
| TPH | 82.76 |
| Kiln Feed Consumption | 2,789.00 |
| Clinker Factor | 1.66 |
| Raw Meal Consumption Factor | 1.55 |

For the same entry the API returns only: `name`, `production_date`, `picking_type`, `product`, `uom`, `total_input_qty`, `produced_qty`, `consumed_items[]`. The `total_input_qty` (2,842) and `produced_qty` (1,680) match the form exactly, so this is the right record — the other columns are simply not selected.

**What we need**

1. Add to each entry: **Coal NCV**, **Running Hours**, **TPH**, **Kiln Feed Consumption**, **Clinker Factor**, **Raw Meal Consumption Factor**.
2. Add **Status / Approval Status**, so we can tell an approved entry from a draft. Still outstanding from our previous request.
3. Add a **Crusher** picking-type group, and an **RM1 / RM2 tag** on raw-meal entries. Also outstanding.
4. If a `write_date` is available, please include it.

**Two details that will save us a round trip**

- **Running Hours format.** The form shows `20:18`. Please send it either as decimal hours (`20.3`) or as the `HH:MM` string, and tell us which — we store hours as a number, and we would rather parse it correctly than guess.
- **Field names.** Please include the technical field name for each one you add (as in `produced_qty`), not only the label. With those we can map them the same day.

**Why these two matter most**

- **Coal NCV** is the only missing input to our Heat Consumption KPI (kcal/kg clinker). We already get clinker produced and kiln coal consumed from you; without NCV the KPI cannot compute at all, so two figures on the plant dashboard sit blank.
- **Running Hours** covers 15 fields on our daily production report that are otherwise typed by hand every day.

Between them these would take the report from 24 auto-filled fields to about 41, with no new data entry at the plant.

Please confirm whether these can be added to the response and a rough timeline.

Regards,

[Name]
IT / MIS
Lake Cement Ltd
