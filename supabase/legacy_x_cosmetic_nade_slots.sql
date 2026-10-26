-- A grenade trail or light worn on one kind of grenade only (owner request 2026-10-26): five slots, HE, flash, smoke, fire (molotov and
-- incendiary) and decoy. The row in cosmetic_equipped stays the default for every grenade; a row here replaces it for one grenade.
-- item_id NULL means "nothing on this grenade"; no row means "follow the default". Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_nade_slot (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  nade text NOT NULL CHECK (nade IN ('he', 'flash', 'smoke', 'fire', 'decoy')),
  kind text NOT NULL CHECK (kind IN ('grenade_trail', 'grenade_light')),
  item_id text REFERENCES legacy_x.cosmetic_items(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, nade, kind)
);
ALTER TABLE legacy_x.cosmetic_nade_slot ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.cosmetic_nade_slot TO service_role;
NOTIFY pgrst, 'reload schema';
