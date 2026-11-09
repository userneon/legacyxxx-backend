-- 1 LX = 1 MNT (owner request 2026-11-09, confirmed the same day: new prices, many top-up packages, every wallet starts again).
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
UPDATE legacy_x.shop_products SET slug = 'lx-5250', name = '5,250 LX',  description = 'Plus 5%',  price_mnt = 5000,  grants_lx = 5250,  sort = 30 WHERE id = 'a56a6d6b-17be-4853-a13d-c410dc138f0b';
UPDATE legacy_x.shop_products SET slug = 'lx-11000', name = '11,000 LX', description = 'Plus 10%', price_mnt = 10000, grants_lx = 11000, sort = 40 WHERE id = 'e3a3ae23-e667-45d1-8d04-d96a25ba0ed7';
UPDATE legacy_x.shop_products SET slug = 'lx-23000', name = '23,000 LX', description = 'Plus 15%', price_mnt = 20000, grants_lx = 23000, sort = 50 WHERE id = '27767d14-4efe-48cb-9f7b-f4e2b7e28105';
INSERT INTO legacy_x.shop_products (slug, kind, name, description, price_mnt, grants_lx, stock, enabled, sort) VALUES
  ('lx-1000', 'lx', '1,000 LX',   'Try it',                  1000,   1000,   100000, true, 10),
  ('lx-3000', 'lx', '3,000 LX',   'A few small things',      3000,   3000,   100000, true, 20),
  ('lx-60000', 'lx', '60,000 LX',  'Plus 20%. A clan and more', 50000,  60000,  100000, true, 60),
  ('lx-125000', 'lx', '125,000 LX', 'Plus 25%',                100000, 125000, 100000, true, 70);

-- Every wallet starts again at the welcome amount (250 LX): the old numbers were at the old scale and mostly test money. Each wallet gets one 'adjust' line
-- in its history (the history is append-only, so nothing is erased), and the clan banks (two test banks) go to zero the same way.
DO $$
DECLARE w RECORD;
BEGIN
  FOR w IN SELECT user_id, balance FROM legacy_x.wallets WHERE balance <> 250 LOOP
    PERFORM legacy_x.wallet_apply(w.user_id, 250 - w.balance, 'adjust', 'LX is now 1 tugrug: balance started again at 250', 'lx-reset:20261109', NULL);
  END LOOP;
  FOR w IN SELECT clan_id, balance FROM legacy_x.clan_bank WHERE balance <> 0 LOOP
    INSERT INTO legacy_x.clan_bank_log (clan_id, user_id, amount, reason, ref, balance_after) VALUES (w.clan_id, NULL, -w.balance, 'LX is now 1 tugrug: bank started again', 'lx-reset:20261109:' || w.clan_id, 0);
    UPDATE legacy_x.clan_bank SET balance = 0, updated_at = now() WHERE clan_id = w.clan_id;
  END LOOP;
END $$;

-- Undo (prices only; wallets are not undone: their old balances are in wallet_transactions as the 'adjust' line's opposite): UPDATE legacy_x.cosmetic_items c SET price = b.old_price FROM legacy_x.price_backup_20261109 b WHERE b.item_id = c.id;
