-- Clan appearance: a clan (bought by its leader with coins) owns tag colours, tag glows and backdrops, and wears one of each.
-- The catalog lives in the API code (server/legacyX/clanLooks.ts); only ownership and what is worn is stored. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.clan_look_owned (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  item_id text NOT NULL CHECK (item_id ~ '^[a-z0-9-]{2,40}$'),
  bought_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, item_id)
);
CREATE TABLE IF NOT EXISTS legacy_x.clan_look_equipped (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tag_color', 'tag_glow', 'backdrop', 'page')),
  item_id text NOT NULL CHECK (item_id ~ '^[a-z0-9-]{2,40}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, kind)
);
ALTER TABLE legacy_x.clan_look_owned ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_look_equipped ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_look_owned, legacy_x.clan_look_equipped FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_look_owned, legacy_x.clan_look_equipped TO service_role;
NOTIFY pgrst, 'reload schema';
-- Added later: the whole-page background. Safe to re-run.
ALTER TABLE legacy_x.clan_look_equipped DROP CONSTRAINT IF EXISTS clan_look_equipped_kind_check;
ALTER TABLE legacy_x.clan_look_equipped ADD CONSTRAINT clan_look_equipped_kind_check CHECK (kind IN ('tag_color', 'tag_glow', 'backdrop', 'page'));

-- Appearance belongs to the player who bought it (the leader), not to the clan: it stays theirs when a clan is deleted. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.clan_look_owned_player (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  item_id text NOT NULL CHECK (item_id ~ '^[a-z0-9-]{2,40}$'),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
ALTER TABLE legacy_x.clan_look_owned_player ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_look_owned_player FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_look_owned_player TO service_role;
INSERT INTO legacy_x.clan_look_owned_player (user_id, item_id, acquired_at)
  SELECT bought_by, item_id, acquired_at FROM legacy_x.clan_look_owned WHERE bought_by IS NOT NULL
  ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
