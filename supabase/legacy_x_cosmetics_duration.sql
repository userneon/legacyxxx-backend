-- Bought cosmetics are rented (2026-10-24): 1 day, 7 days, 30 days or forever, priced as a share of the item's price (30 days = 100%).
-- `expires_at` is NULL for a forever item and for everything not bought with LX (free, achievement, staff). Safe to re-run.
ALTER TABLE legacy_x.cosmetic_owned ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS cosmetic_owned_expires_idx ON legacy_x.cosmetic_owned (expires_at) WHERE expires_at IS NOT NULL;

-- RUN ONCE (owner decision 2026-10-24): what players bought with LX before this change runs out 30 days after the moment this ran.
-- Do not run the UPDATE again after the new shop is live: a "forever" item bought later would be given an end date too.
UPDATE legacy_x.cosmetic_owned SET expires_at = now() + interval '30 days' WHERE source = 'coin' AND expires_at IS NULL;
