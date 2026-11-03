-- Skinchanger → Advanced studio (owner request 2026-11-03): a player builds a look (a weapon, a skin, wear, pattern, StatTrak, name tag,
-- stickers, a charm) once, saves it as a craft and later picks it from the loadout. A craft is not applied to the game by itself.
-- Only the Root API (service_role) reads or writes this table. Safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.skin_crafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES legacy_x.skinchanger_catalog_items(id) ON DELETE RESTRICT,
  name text NOT NULL DEFAULT '' CHECK (char_length(name) <= 40),
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skin_crafts_user_idx ON legacy_x.skin_crafts (user_id, created_at DESC);

ALTER TABLE legacy_x.skin_crafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.skin_crafts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.skin_crafts TO service_role;

COMMIT;
