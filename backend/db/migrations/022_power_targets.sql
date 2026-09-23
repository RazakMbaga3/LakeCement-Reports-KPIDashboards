-- 022: fixed Specific Power targets for the Power Consumption Report.
--
-- Why this exists: Section 1's "Target (kWh/MT)" column was a plain
-- <input value="X.XX"> baked into forms/power-form.html — editable in the
-- browser, but never saved anywhere, so every officer who opened the page
-- saw (and could silently change) whatever number was hardcoded in the
-- HTML that day. Targets are a fixed, roughly-yearly engineering figure,
-- not something that varies report to report, so they belong in the
-- database the same way the governed stoppage-reason catalogue does
-- (migration 017) — one authoritative value per section, edited
-- deliberately through its own small control, read the same way by every
-- day's report rather than typed in fresh (or drifted) each time.
--
-- Seeded with the values corrected against the real 20.09.2026.xlsx report
-- on 2026-09-22 (see forms/power-form.html's Section 1 comment for the
-- old-vs-new table).
CREATE TABLE IF NOT EXISTS power_targets (
  section       VARCHAR(20)  PRIMARY KEY,   -- crusher|rawmill|coalmill|kiln|cm1|cm2|packing|utilities
  target_kwh_mt NUMERIC(8,2) NOT NULL,
  updated_by    INTEGER REFERENCES users(id),   -- NULL = seeded, not set by a user
  updated_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);

INSERT INTO power_targets (section, target_kwh_mt) VALUES
  ('crusher',    1.20),
  ('rawmill',   17.00),
  ('coalmill',  32.00),
  ('kiln',      24.00),
  ('cm1',       35.00),
  ('cm2',       35.00),
  ('packing',    0.90),
  ('utilities',  1.90)
ON CONFLICT (section) DO NOTHING;
