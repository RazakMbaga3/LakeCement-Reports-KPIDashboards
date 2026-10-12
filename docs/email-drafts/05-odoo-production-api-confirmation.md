# Draft mail — reply confirming the updated production entry API

**To:** Ankita P (Teckzilla) · info@planet-odoo.com
**Cc:** Saurabh Bhattacharya · Pavan Gandhi · Dipesh Sahni
**From:** Digital | Lake Cement
**Subject:** Re: Production entry report API updated — tested and confirmed

---

Hi Ankita,

Tested and confirmed — thank you. Everything we asked for is coming through, and it is already live on our dashboard.

**Confirmed working**

Checked against CLK/2026/00183 (08/10/2026) and 53 entries across 6–9 October:

| Field | Example value |
| --- | --- |
| `coal_ncv` | 5,504 |
| `running_hours` | 20.1 |
| `tph` | 72.14 |
| `kiln_feed_value` | 2,407 |
| `kiln_fact_value` / `production_fact_value` | 1.66 / 1.55 |
| `state` / `approval_status` | Approved |
| `write_date` | 09/10/2026 11:53:26 |

The **Crusher** group is also now present and carries `production_qty`, `running_hours` and `apron_feeder_hrs`. All 53 entries returned `state: "Approved"`.

Two things you answered without our having to ask again: `running_hours` arrives as decimal hours rather than the `HH:MM` the form displays, and `write_date` is on every entry. Both are exactly what we needed.

**What this unlocked at our end**

Coal NCV was the last missing input to our Heat Consumption KPI. It had been blank since June; it now calculates at 837–959 kcal/kg clinker. Kiln, coal mill and crusher running hours, and crusher output, are also filling automatically now — roughly seventeen more fields a day that nobody has to type.

**One item still open**

An **RM1 / RM2 tag on raw-meal entries**. Raw Meal entries carry `mill_type`, but it reads `"CM1"` — the same value appears on Clinker and Coal Mill entries, so it does not identify which raw mill ran. Our report tracks RM1 and RM2 separately, so without a tag we hold Odoo's raw-meal figure as a single combined number rather than splitting it between the two mills.

Not urgent, but worth adding when convenient.

**One note for next time — not a complaint, just a heads-up**

The update also renamed several existing fields: `produced_qty` → `production_qty`, `consumed_items` → `line_items`, and the line keys (`input_quantity` → `quantity`, `final_qty_after_moisture` → `final_qty`, `stock_available` → `qty_available`, `moisture` → `moisture_percent`, `product` → `product_id`, `uom` → `uom_id`, `cost` → `standard_price`). The response group keys also shortened, for example `CEMENT: Cement Production (CM1)` → `Cement`.

Our integration reads the old names until we caught up, so no data was lost — but it did stop storing production entries until we updated it, and because the API call itself still succeeded our monitoring reported everything as healthy. If renames like these could come with a short note beforehand, we can have the change ready on the same day.

One small thing that would help either way: where a value is not available, `null` is easier for us to handle than `0`. `coal_ncv` comes through as `0` on Raw Meal, Cement and Coal Mill entries, and a zero calorific value would be a valid-looking but wrong figure if read literally. We filter it out on our side, so nothing is broken — it is just safer as `null`.

Thanks again for turning this around quickly. The production report is now live from Odoo with no manual re-entry, which is exactly what we were after.

Best regards,

[Name]
Digital | Lake Cement Ltd
