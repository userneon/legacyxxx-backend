-- The Crystal Orb avatar frame (owner request 2026-11-01): a glass ball with a crackling rim and glowing dust round a round avatar, fully set by its owner.
-- One frame item to buy (15,000 LX for 30 days, and only for 30 days: the API sells it no other length; change the price in Staff -> Shop -> Cosmetics) and one row per player
-- that holds the settings they picked (the API checks every value, see server/legacyX/frameLook.ts). Safe to re-run.

BEGIN;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('crystal-orb', 'frame', 'Crystal Orb', 'Болор бөмбөлөг', 'coin', 15000, '', 1, 4, true, true)
ON CONFLICT (id) DO UPDATE SET enabled = true;

CREATE TABLE IF NOT EXISTS legacy_x.frame_looks (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users (id) ON DELETE CASCADE,
  look jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.frame_looks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.frame_looks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.frame_looks TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
