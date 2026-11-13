-- Two more paid ranks (owner request 2026-11-13, "make it 5"): Prime below Prestige (copper, 1 command) and Sovereign above Eternal (diamond, 15 commands).
-- Deploy the API first (it knows tier4 and tier5 from perks.ts), then run this once. The prices follow the other tiers' own ratios (30 days = 5/3 of 14,
-- 90 days = 25/6 of 14): Prime 12,000 / 20,000 / 50,000, Sovereign 120,000 / 200,000 / 500,000. The Owner can change names and prices any time:
--   UPDATE legacy_x.perk_tiers SET name = '…', price_14 = …, price_30 = …, price_90 = … WHERE key = 'tier4';
-- The table only allowed tier1 to tier3 as keys.
ALTER TABLE legacy_x.perk_tiers DROP CONSTRAINT IF EXISTS perk_tiers_key_check;
ALTER TABLE legacy_x.perk_tiers ADD CONSTRAINT perk_tiers_key_check CHECK (key IN ('tier1', 'tier2', 'tier3', 'tier4', 'tier5'));

INSERT INTO legacy_x.perk_tiers (key, name, sort, price_14, price_30, price_90, enabled) VALUES
  ('tier4', 'Prime', 0, 12000, 20000, 50000, true),
  ('tier5', 'Sovereign', 4, 120000, 200000, 500000, true)
ON CONFLICT (key) DO NOTHING;
