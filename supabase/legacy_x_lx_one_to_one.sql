-- 1 LX = 1 MNT (owner request 2026-11-09). PREPARED, NOT RUN until the owner confirms the prices below.
-- The old prices are kept in legacy_x.price_backup_20261109 so this can be undone (see the end of the file).

CREATE TABLE IF NOT EXISTS legacy_x.price_backup_20261109 (item_id text PRIMARY KEY, old_price integer NOT NULL);
INSERT INTO legacy_x.price_backup_20261109 (item_id, old_price)
  SELECT id, price FROM legacy_x.cosmetic_items ON CONFLICT (item_id) DO NOTHING;

-- Small items (name colours and glows, smokes, trails): five times the old number, nearest 500, at least 1,000.
UPDATE legacy_x.cosmetic_items SET price = GREATEST(1000, ROUND(price * 5 / 500.0)::int * 500)
 WHERE kind IN ('name_color', 'name_glow', 'smoke_color', 'grenade_trail') AND price > 0;

-- The big things are rented for 1, 7 or 30 days (nothing is for good), so they cost less than the old LX x 6.67 would have made them.
UPDATE legacy_x.cosmetic_items SET price = 5000   WHERE kind = 'frame' AND price = 1000;      -- painted and frog frames
UPDATE legacy_x.cosmetic_items SET price = 25000  WHERE kind = 'frame' AND price = 15000;     -- Crystal Orb
UPDATE legacy_x.cosmetic_items SET price = 15000  WHERE kind = 'background' AND price = 10000;
UPDATE legacy_x.cosmetic_items SET price = 20000  WHERE kind = 'model_knife' AND price = 12000;
UPDATE legacy_x.cosmetic_items SET price = 25000  WHERE kind = 'model_knife' AND price = 15000;
UPDATE legacy_x.cosmetic_items SET price = 15000  WHERE kind IN ('model_ak47', 'model_deagle') AND price = 10000;

-- Top-up: many packages, the bigger the better (price in MNT, grants_lx at least as many LX). The smallest package sets the rate of a free amount (1:1).
UPDATE legacy_x.shop_products SET name = '5,250 LX',  description = 'Plus 5%',  price_mnt = 5000,  grants_lx = 5250,  sort = 30 WHERE id = 'a56a6d6b-17be-4853-a13d-c410dc138f0b';
UPDATE legacy_x.shop_products SET name = '11,000 LX', description = 'Plus 10%', price_mnt = 10000, grants_lx = 11000, sort = 40 WHERE id = 'e3a3ae23-e667-45d1-8d04-d96a25ba0ed7';
UPDATE legacy_x.shop_products SET name = '23,000 LX', description = 'Plus 15%', price_mnt = 20000, grants_lx = 23000, sort = 50 WHERE id = '27767d14-4efe-48cb-9f7b-f4e2b7e28105';
INSERT INTO legacy_x.shop_products (kind, name, description, price_mnt, grants_lx, stock, enabled, sort) VALUES
  ('lx', '1,000 LX',   'Try it',                  1000,   1000,   100000, true, 10),
  ('lx', '3,000 LX',   'A few small things',      3000,   3000,   100000, true, 20),
  ('lx', '60,000 LX',  'Plus 20%. A clan and more', 50000,  60000,  100000, true, 60),
  ('lx', '125,000 LX', 'Plus 25%',                100000, 125000, 100000, true, 70);

-- Undo (prices only): UPDATE legacy_x.cosmetic_items c SET price = b.old_price FROM legacy_x.price_backup_20261109 b WHERE b.item_id = c.id;
