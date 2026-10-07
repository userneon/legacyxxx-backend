-- Linking Discord from the website: a one-time state ties the Discord consent back to the signed-in player. Only the
-- state's hash is stored. Only the API (service_role) uses the table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.discord_oauth_states (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.discord_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.discord_oauth_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.discord_oauth_states TO service_role;
