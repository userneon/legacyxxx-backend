-- LX top-ups ride on the Shop goods orders: a product of kind 'lx' is a package that gives `grants_lx` LX when its order is
-- marked paid (the API credits the wallet once, with the ref topup:<order id>). Run after legacy_x_shop_goods.sql. Safe to re-run.
--
-- The rate is 3,000 LX = 20,000 MNT (about 6.67 MNT per LX). The three packages below follow it; an Owner or Manager can change
-- them, add bigger ones or hide them in Staff → Shop.

BEGIN;

ALTER TABLE legacy_x.shop_products DROP CONSTRAINT IF EXISTS shop_products_kind_check;
ALTER TABLE legacy_x.shop_products ADD CONSTRAINT shop_products_kind_check CHECK (kind IN ('charm', 'sticker', 'other', 'lx'));
ALTER TABLE legacy_x.shop_products ADD COLUMN IF NOT EXISTS grants_lx integer NOT NULL DEFAULT 0 CHECK (grants_lx >= 0);

INSERT INTO legacy_x.shop_products (slug, name, description, kind, price_mnt, stock, grants_lx, sort) VALUES
  ('lx-750', '750 LX', 'Small top-up', 'lx', 5000, 100000, 750, 10),
  ('lx-1500', '1,500 LX', 'Medium top-up', 'lx', 10000, 100000, 1500, 20),
  ('lx-3000', '3,000 LX', 'Large top-up. Enough for a clan.', 'lx', 20000, 100000, 3000, 30)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
