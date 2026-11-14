-- Profile customize (owner request 2026-11-14): one Shop product, "Profile customize", rented for 1, 7 or 30 days like every other cosmetic. While it runs the player may
--   * style their name: Normal (a colour, and a font), Gradient (two colours) or Glow (a glowing colour), and
--   * upload their own profile banner.
-- The old Name colour and Name glow items are retired: every one still running is paid back (the ledger's latest purchase line, once per player and item).
-- The look is read live: when the rental runs out the name goes back to plain and the banner is not shown (the picture and the settings stay, so renewing brings them back).
-- Safe to re-run.

BEGIN;

ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background', 'model_knife', 'model_deagle', 'model_ak47', 'profile_customize'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background', 'model_knife', 'model_deagle', 'model_ak47', 'profile_customize'));

-- The product. The price is the 30-day price (1 day costs 25%, 7 days 60%); the Owner changes it in Staff -> Shop -> Cosmetics.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, enabled)
VALUES ('profile-customize', 'profile_customize', 'Profile customize', 'Профайл тохиргоо', 'coin', 6000, '', 1, true)
ON CONFLICT (id) DO NOTHING;

-- What a player set: the name mode, font and colours. One row per player.
CREATE TABLE IF NOT EXISTS legacy_x.profile_looks (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  name_mode text NOT NULL DEFAULT 'normal' CHECK (name_mode IN ('normal', 'gradient', 'glow')),
  name_font text NOT NULL DEFAULT 'default' CHECK (name_font IN ('default', 'display', 'mono')),
  name_color text CHECK (name_color IS NULL OR name_color ~ '^#[0-9a-fA-F]{6}$'),
  name_color2 text CHECK (name_color2 IS NULL OR name_color2 ~ '^#[0-9a-fA-F]{6}$'),
  name_glow text CHECK (name_glow IS NULL OR name_glow ~ '^#[0-9a-fA-F]{6}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.profile_looks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.profile_looks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.profile_looks TO service_role;

-- The player's own banner picture (checked by the API before it is stored, served back by GET /profile-banner/:userId).
CREATE TABLE IF NOT EXISTS legacy_x.profile_banners (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 5242880),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.profile_banners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.profile_banners FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.profile_banners TO service_role;

-- The old name items go: switched off, taken off, and paid back.
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE kind IN ('name_color', 'name_glow');
DELETE FROM legacy_x.cosmetic_equipped WHERE kind IN ('name_color', 'name_glow');

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.item_id, i.name_en,
           (SELECT -t.amount FROM legacy_x.wallet_transactions t
             WHERE t.user_id = o.user_id AND t.kind = 'spend' AND t.ref LIKE 'cosmetic:' || o.item_id || ':%'
             ORDER BY t.created_at DESC LIMIT 1) AS paid
      FROM legacy_x.cosmetic_owned o JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
     WHERE i.kind IN ('name_color', 'name_glow') AND o.source = 'coin' AND (o.expires_at IS NULL OR o.expires_at > now())
  LOOP
    IF r.paid IS NOT NULL AND r.paid > 0 THEN
      PERFORM legacy_x.wallet_apply(r.user_id, r.paid, 'refund', 'Name styles replaced by Profile customize: ' || r.name_en, 'name-style-removed:' || r.user_id || ':' || r.item_id, NULL);
    END IF;
  END LOOP;
END $$;

DELETE FROM legacy_x.cosmetic_owned o USING legacy_x.cosmetic_items i WHERE i.id = o.item_id AND i.kind IN ('name_color', 'name_glow') AND o.source = 'coin';

COMMIT;
