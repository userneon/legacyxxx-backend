-- Anti-cheat evidence (owner request 2026-11-06): every detection the CS2AC anti-cheat reports on a game server is written here with what the server knew at the
-- time and what was decided (ban, or only a flag and why). A ban made from a detection still goes through the ordinary ban route; this is the record behind it,
-- for the staff who answer an appeal and for the checks that stop a false ban (the same detector firing on many players at once, a repeat within ten minutes).
CREATE TABLE IF NOT EXISTS legacy_x.anticheat_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id text NOT NULL CHECK (steam_id ~ '^7656119\d{10}$'),
  user_id uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  detector text NOT NULL,
  detail text,
  server_id text,
  map_name text,
  server_mode text,
  action text NOT NULL CHECK (action IN ('ban', 'flag')),
  decision text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS anticheat_flags_player_idx ON legacy_x.anticheat_flags (steam_id, created_at DESC);
CREATE INDEX IF NOT EXISTS anticheat_flags_server_idx ON legacy_x.anticheat_flags (server_id, detector, created_at DESC);
ALTER TABLE legacy_x.anticheat_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.anticheat_flags FROM anon, authenticated;
GRANT SELECT, INSERT ON legacy_x.anticheat_flags TO service_role;
