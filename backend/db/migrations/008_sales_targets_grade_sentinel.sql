-- 008: sales_targets.grade_key must not be NULL. Postgres treats every
-- NULL as distinct under UNIQUE, so UNIQUE(target_month, officer_code,
-- grade_key) never actually deduped the all-grades target rows —
-- grade_key was always NULL for them (routes/sales.js's POST /targets
-- always inserted NULL), so "ON CONFLICT ... DO UPDATE" never matched an
-- existing row and every target correction silently inserted a new one.
-- services/sales.js's companyTotal sums every row for the month, so it
-- inflated with each correction, with no error anywhere. The same
-- NULL-distinctness gotcha was already solved one column over for
-- officer_code via the '_company' sentinel (see 006_sales.sql's header) —
-- grade_key gets the same fix here.

-- Step 1: collapse duplicate rows the bug already created, keeping only
-- the most recently-updated row per (target_month, officer_code). Only
-- touches grade_key IS NULL rows — a real future per-grade breakdown
-- (non-NULL grade_key) is untouched.
DELETE FROM sales_targets t
USING (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY target_month, officer_code
    ORDER BY updated_at DESC, id DESC
  ) AS rn
  FROM sales_targets
  WHERE grade_key IS NULL
) ranked
WHERE t.id = ranked.id AND ranked.rn > 1;

-- Step 2: sentinel instead of NULL — safe now, at most one row per key.
UPDATE sales_targets SET grade_key = '_all' WHERE grade_key IS NULL;
ALTER TABLE sales_targets ALTER COLUMN grade_key SET DEFAULT '_all';
ALTER TABLE sales_targets ALTER COLUMN grade_key SET NOT NULL;
