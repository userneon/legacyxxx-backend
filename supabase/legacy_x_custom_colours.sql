-- Colours picked by hand (owner request 2026-10-24): a player buys "Custom colour" / "Custom glow" once (50% above the plain colour) and picks the
-- colour; a clan leader buys a custom tag colour, tag glow, backdrop or page background (one per animated effect) and picks its colours.
-- Only the picked values are stored; the items live in cosmetic_items (player) and server/legacyX/clanLooks.ts (clan). Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_custom (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES legacy_x.cosmetic_items(id) ON DELETE CASCADE,
  color text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
ALTER TABLE legacy_x.cosmetic_custom ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.cosmetic_custom FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.cosmetic_custom TO service_role;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, glow, fx, rarity) VALUES
  ('name-custom', 'name_color', 'Custom colour', 'Өөрийн өнгө', 'coin', 150, '', 90, '#8b5cf6', NULL, NULL, 3),
  ('glow-custom', 'name_glow', 'Custom glow', 'Өөрийн гэрэл', 'coin', 225, '', 90, NULL, '#8b5cf6', 'neon', 3)
ON CONFLICT (id) DO NOTHING;

-- The clan table made earlier the same day held one background per clan; it now holds one row per clan and custom item.
DROP TABLE IF EXISTS legacy_x.clan_look_custom;
CREATE TABLE legacy_x.clan_look_custom (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  item_id text NOT NULL CHECK (item_id ~ '^[a-z0-9-]{2,40}$'),
  color_a text NOT NULL CHECK (color_a ~ '^#[0-9a-f]{6}$'),
  color_b text CHECK (color_b IS NULL OR color_b ~ '^#[0-9a-f]{6}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, item_id)
);
ALTER TABLE legacy_x.clan_look_custom ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_look_custom FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_look_custom TO service_role;
NOTIFY pgrst, 'reload schema';
