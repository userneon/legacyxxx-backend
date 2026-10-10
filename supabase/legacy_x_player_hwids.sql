-- Hardware fingerprint of the PC a player ran the checker on. Only hashes: the program hashes each serial number on the PC and sends the hashes,
-- never the numbers. One row per player and part, so two accounts that played on the same PC (same board, CPU, disk ...) can be told apart from
-- two that did not. verified = the player's Steam account was found on that PC. Only the API (service_role) touches this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.player_hwids (
  steam_id text NOT NULL CHECK (steam_id ~ '^[0-9]{17}$'),
  kind text NOT NULL CHECK (kind IN ('id', 'uuid', 'board', 'bios', 'cpu', 'disk', 'machine')),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  verified boolean NOT NULL DEFAULT false,
  check_id uuid REFERENCES legacy_x.player_checks(id) ON DELETE SET NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id, kind, hash)
);
CREATE INDEX IF NOT EXISTS player_hwids_hash_idx ON legacy_x.player_hwids (kind, hash);
ALTER TABLE legacy_x.player_hwids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.player_hwids FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.player_hwids TO service_role;
NOTIFY pgrst, 'reload schema';
