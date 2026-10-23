-- The LEGACY-X Genesis pack (owner decision 2026-10-23; named Founder at first, renamed Genesis the same day because Founder is already a staff role): a numbered, limited set sold once for 30,000 MNT through a Shop order
-- (staff take the payment, as for goods and LX top-ups). Marking the order paid gives the buyer the next Genesis number and four things:
-- the Genesis frame, the Gold Foil profile banner, the Genesis title and a gold Genesis badge (the number) on their profile. (Internal ids keep the word founder.)
-- Run after legacy_x_shop_goods.sql, legacy_x_lx_topups.sql and legacy_x_cosmetics_emotes.sql. Safe to re-run.

BEGIN;

-- Cosmetic kinds: banner and title join frame, name colour, name glow and emote.
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title'));

-- The three Genesis cosmetics are earned, never sold for LX.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, fx, rarity, featured, enabled) VALUES
  ('founder', 'frame', 'Genesis', 'Genesis', 'achievement', 0, 'Genesis pack', 30, NULL, 4, false, true),
  ('banner-gold-foil', 'banner', 'Gold Foil', 'Алтан тугалга', 'achievement', 0, 'Genesis pack', 1, 'goldfoil', 4, false, true),
  ('title-founder', 'title', 'Genesis', 'Genesis', 'achievement', 0, 'Genesis pack', 1, NULL, 4, false, true)
ON CONFLICT (id) DO NOTHING;

-- Shop product kind and a sales deadline.
ALTER TABLE legacy_x.shop_products DROP CONSTRAINT IF EXISTS shop_products_kind_check;
ALTER TABLE legacy_x.shop_products ADD CONSTRAINT shop_products_kind_check CHECK (kind IN ('charm', 'sticker', 'other', 'lx', 'founder'));
ALTER TABLE legacy_x.shop_products ADD COLUMN IF NOT EXISTS ends_at timestamptz;

-- `stock` of the Genesis product is the total number of packs; the Genesis number is 1, 2, 3 ... in the order they are paid.
INSERT INTO legacy_x.shop_products (slug, name, description, kind, price_mnt, stock, ends_at, sort)
VALUES ('founder-pack', 'LEGACY-X Genesis', 'Numbered, limited, never sold again: Genesis frame, Gold Foil banner, Genesis title and badge.', 'founder', 30000, 500, '2026-11-30T23:59:59+08:00', 1)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS legacy_x.founders (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  number integer NOT NULL UNIQUE CHECK (number > 0),
  order_id uuid UNIQUE REFERENCES legacy_x.shop_orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.founders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.founders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON legacy_x.founders TO service_role;

-- Gives a paid order's buyer the next Genesis number and the three cosmetics. Idempotent per player: a second call returns the same number.
-- Raises founder_sold_out when `p_limit` numbers are taken. One advisory lock keeps the numbers 1..N with no gaps or duplicates.
CREATE OR REPLACE FUNCTION legacy_x.founder_claim(p_user uuid, p_order uuid, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE v_number integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('legacy_x.founder_claim'));
  SELECT number INTO v_number FROM legacy_x.founders WHERE user_id = p_user;
  IF v_number IS NULL THEN
    SELECT COALESCE(max(number), 0) + 1 INTO v_number FROM legacy_x.founders;
    IF v_number > p_limit THEN
      RAISE EXCEPTION 'founder_sold_out' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO legacy_x.founders (user_id, number, order_id) VALUES (p_user, v_number, p_order);
  END IF;
  INSERT INTO legacy_x.cosmetic_owned (user_id, item_id, source)
  SELECT p_user, id, 'staff' FROM legacy_x.cosmetic_items WHERE id IN ('founder', 'banner-gold-foil', 'title-founder')
  ON CONFLICT (user_id, item_id) DO NOTHING;
  RETURN v_number;
END;
$$;
REVOKE ALL ON FUNCTION legacy_x.founder_claim(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.founder_claim(uuid, uuid, integer) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
