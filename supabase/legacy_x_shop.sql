-- Shop: every item has a rarity (1 common ... 4 legendary) and may be featured. Achievement items are the hardest to get,
-- so they are legendary. A few top items cost more so the higher tiers exist. Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS rarity smallint NOT NULL DEFAULT 1 CHECK (rarity BETWEEN 1 AND 4);
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;

UPDATE legacy_x.cosmetic_items SET price = 700 WHERE id IN ('planet-orbit', 'ice-crystals') AND unlock = 'coin';
UPDATE legacy_x.cosmetic_items SET price = 650 WHERE id = 'prism-glass' AND unlock = 'coin';
UPDATE legacy_x.cosmetic_items SET price = 900 WHERE id = 'color-holo' AND unlock = 'coin';
UPDATE legacy_x.cosmetic_items SET price = 600 WHERE id = 'color-goldfoil' AND unlock = 'coin';

UPDATE legacy_x.cosmetic_items SET rarity = CASE
  WHEN unlock = 'achievement' THEN 4
  WHEN unlock = 'free' OR price <= 250 THEN 1
  WHEN price <= 500 THEN 2
  ELSE 3 END;

UPDATE legacy_x.cosmetic_items SET featured = id IN ('planet-orbit', 'color-holo', 'glow-royal', 'ice-crystals');
