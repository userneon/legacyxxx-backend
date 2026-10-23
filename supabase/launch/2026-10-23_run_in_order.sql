-- LEGACY-X: every SQL file added since the shop goods, in the order to run them (production already has all of them since 2026-10-23).
-- Paste this whole file into Supabase -> SQL editor and run it once on a database that does not have them. Needs legacy_x_cosmetics_premium.sql to have run before.
-- Every part is safe to run again. Take a backup first (Supabase -> Database -> Backups).

-- ============================================================
-- legacy_x_shop_goods.sql
-- ============================================================
-- Real goods in the Shop (NFC charms, stickers): the catalogue and the orders players ask for.
--
-- No payment happens in the app or on the site. A player asks for an item with a phone number; an Owner or Manager contacts them,
-- takes the payment (bank transfer or QPay) and moves the order along: new → contacted → paid → shipped → done (or cancelled).
-- Only the Root API (service_role) reads or writes these tables. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.shop_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 600),
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('charm', 'sticker', 'other')),
  price_mnt integer NOT NULL CHECK (price_mnt >= 0),
  image_url text CHECK (image_url IS NULL OR image_url ~ '^https://'),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  enabled boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.shop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES legacy_x.shop_products(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_mnt integer NOT NULL CHECK (unit_price_mnt >= 0),
  phone text NOT NULL CHECK (phone ~ '^[0-9+ -]{8,20}$'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'paid', 'shipped', 'done', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_orders_user_idx ON legacy_x.shop_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_orders_status_idx ON legacy_x.shop_orders (status, created_at);

ALTER TABLE legacy_x.shop_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.shop_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.shop_products, legacy_x.shop_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.shop_products, legacy_x.shop_orders TO service_role;

COMMIT;

-- ============================================================
-- legacy_x_lx_topups.sql
-- ============================================================
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

-- ============================================================
-- legacy_x_cosmetics_emotes.sql
-- ============================================================
-- Emotes, next to frames and name styles: a short line (and sound) a player plays in game with .e. Same rules as the other cosmetics:
-- (the kind list already includes banner and title from legacy_x_founder.sql, so this file stays safe to re-run after it).
-- free / coin (bought once with LX) / achievement (earned). `fx` is the key the game plugin knows the emote by; nothing else is sent to a page or server.
-- `game_key` is the name the animated-emote plugin knows an emote by (any text); it takes the place of `fx` for those.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS game_key text CHECK (game_key IS NULL OR char_length(game_key) BETWEEN 1 AND 80);
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, fx, rarity) VALUES
  ('emote-gg', 'emote', 'GG', 'GG', 'free', 0, '', 1, 'gg', 1),
  ('emote-hello', 'emote', 'Hello', 'Сайн уу', 'coin', 100, '', 2, 'hello', 1),
  ('emote-gl', 'emote', 'Good Luck', 'Амжилт', 'coin', 100, '', 3, 'gl', 1),
  ('emote-nice', 'emote', 'Nice Shot', 'Сайн буудлаа', 'coin', 150, '', 4, 'nice', 2),
  ('emote-clap', 'emote', 'Applause', 'Алга ташилт', 'coin', 150, '', 5, 'clap', 2),
  ('emote-salute', 'emote', 'Salute', 'Мэндчилгээ', 'coin', 200, '', 6, 'salute', 2),
  ('emote-fire', 'emote', 'On Fire', 'Галтай', 'coin', 250, '', 7, 'fire', 3),
  ('emote-legacy', 'emote', 'Legacy', 'Legacy', 'achievement', 0, 'Reach the Legacy rank', 8, 'legacy', 4)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- legacy_x_founder.sql
-- ============================================================
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

-- ============================================================
-- legacy_x_genesis_rename.sql
-- ============================================================
-- The Founder pack is now called Genesis (owner decision 2026-10-23): Founder is already a staff role, so a player with that role and the pack
-- would carry two different "Founder" marks. Only the names change; the ids (founder, banner-gold-foil, title-founder, founder-pack) stay,
-- so nothing already bought or worn is affected. Run it if legacy_x_founder.sql ran before the rename; on a new database it changes nothing. Safe to re-run.
UPDATE legacy_x.cosmetic_items SET name_en = 'Genesis', name_mn = 'Genesis', requirement = 'Genesis pack' WHERE id IN ('founder', 'title-founder');
UPDATE legacy_x.cosmetic_items SET requirement = 'Genesis pack' WHERE id = 'banner-gold-foil';
UPDATE legacy_x.shop_products SET name = 'LEGACY-X Genesis', description = 'Numbered, limited, never sold again: Genesis frame, Gold Foil banner, Genesis title and badge.' WHERE slug = 'founder-pack';

-- ============================================================
-- legacy_x_booster_podium.sql
-- ============================================================
-- The booster podium (owner request 2026-10-23): the three members with the most Discord server boosts wear the Gold, Silver and Bronze
-- booster frames. They are earned, never sold, and follow the ranking on Leaders → Boosters: the API gives each frame to its holder and takes it
-- from anyone who loses the place (when the Discord bot reports, and when a member links Discord). Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('booster-gold', 'frame', 'Booster Gold', 'Booster алт', 'achievement', 0, 'The #1 server booster', 40, 4, false, true),
  ('booster-silver', 'frame', 'Booster Silver', 'Booster мөнгө', 'achievement', 0, 'The #2 server booster', 41, 4, false, true),
  ('booster-bronze', 'frame', 'Booster Bronze', 'Booster хүрэл', 'achievement', 0, 'The #3 server booster', 42, 4, false, true)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- legacy_x_cosmetics_retire_duplicates.sql
-- ============================================================
-- Plain name colours that look the same as another one are switched off (owner request 2026-10-22). Each pair is within about 30 steps in RGB,
-- so on screen they read as one colour; the cheaper-to-keep one stays:
--   Sunset (#fdba74) keeps, Apricot (#fbbf77) goes      Pearl (#f5f5f4) keeps, Snow (#f8fafc) goes
--   Steel (#94a3b8) keeps, Graphite (#a3a3a3) goes      Rose (#fda4af) keeps, Peach (#fdba9a) goes
-- A switched-off item stays in the table, so nothing that points at it breaks; the API ignores owned or worn rows of an item that is off.
-- Anyone who paid coins for one gets them back, once (the ref is per player and item). Safe to re-run.

BEGIN;

UPDATE legacy_x.cosmetic_items SET enabled = false
 WHERE kind = 'name_color' AND id IN ('color-apricot', 'color-snow', 'color-graphite', 'color-peach');

DELETE FROM legacy_x.cosmetic_equipped
 WHERE kind = 'name_color' AND item_id IN ('color-apricot', 'color-snow', 'color-graphite', 'color-peach');

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.item_id, i.price, i.name_en
      FROM legacy_x.cosmetic_owned o JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
     WHERE i.kind = 'name_color' AND i.enabled = false AND o.source = 'coin' AND i.price > 0
       AND i.id IN ('color-apricot', 'color-snow', 'color-graphite', 'color-peach')
  LOOP
    PERFORM legacy_x.wallet_apply(r.user_id, r.price, 'refund', 'Name colour retired: ' || r.name_en, 'cosmetic:' || r.item_id || ':retired', NULL);
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- legacy_x_creator_applications.sql
-- ============================================================
-- Creator applications (owner request 2026-10-23): a player asks to become a content creator from the Creators page (a short line about their content and
-- at least one channel link); an Owner or Manager approves (choosing Content Creator or Main Content Creator) or declines from Staff → Creators.
-- Approving creates the legacy_x.content_creators row. Only the Root API (service_role) reads or writes this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.creator_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  bio text NOT NULL CHECK (char_length(bio) BETWEEN 10 AND 200),
  links jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(links) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  decided_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One open application per player.
CREATE UNIQUE INDEX IF NOT EXISTS creator_applications_one_pending ON legacy_x.creator_applications (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS creator_applications_status_idx ON legacy_x.creator_applications (status, created_at);
ALTER TABLE legacy_x.creator_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.creator_applications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.creator_applications TO service_role;
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- legacy_x_site_settings.sql
-- ============================================================
-- Site settings (owner request 2026-10-23): numbers staff can change from the staff site (Staff → Settings, Owner only) instead of the code.
-- A row only exists once a value was changed; without one the API uses the default written in server/legacyX/settings.ts.
-- Only the Root API (service_role) reads or writes this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.site_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9._-]{3,64}$'),
  value numeric NOT NULL,
  updated_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.site_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.site_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.site_settings TO service_role;
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- legacy_x_public_chat.sql
-- ============================================================
-- Public chat (owner request 2026-10-23): one community chat on the website, bottom right. Signed-in players write, everyone reads.
-- Staff can remove a message (deleted_at). A player with an active gag cannot write. Old messages are removed by the API.
-- Only the Root API (service_role) reads or writes this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_recent_idx ON legacy_x.chat_messages (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON legacy_x.chat_messages (user_id, created_at DESC);
ALTER TABLE legacy_x.chat_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.chat_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.chat_messages TO service_role;
NOTIFY pgrst, 'reload schema';

