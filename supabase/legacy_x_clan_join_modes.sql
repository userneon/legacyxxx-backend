-- Clans, part 3: a clan is open (anyone joins at once) or by request (the leader accepts or declines). Safe to re-run.
ALTER TABLE legacy_x.clans ADD COLUMN IF NOT EXISTS join_mode text NOT NULL DEFAULT 'open' CHECK (join_mode IN ('open', 'request'));

CREATE TABLE IF NOT EXISTS legacy_x.clan_join_requests (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, user_id)
);
ALTER TABLE legacy_x.clan_join_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_join_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON legacy_x.clan_join_requests TO service_role;
