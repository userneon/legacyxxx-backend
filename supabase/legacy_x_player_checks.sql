-- Player checks: a staff member (Admin, Manager or Owner) asks a player to run the checker program with a one-time code.
-- The program sends back what it found; staff read it and decide. Nothing here bans anyone by itself.
-- Only the API (service_role) touches this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.player_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_hint text NOT NULL CHECK (char_length(code_hint) = 4),
  target_steam_id text NOT NULL CHECK (target_steam_id ~ '^[0-9]{17}$'),
  target_user_id uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  requested_by uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  checker_version text CHECK (checker_version IS NULL OR char_length(checker_version) <= 20),
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_checks_created_idx ON legacy_x.player_checks (created_at DESC);
CREATE INDEX IF NOT EXISTS player_checks_target_idx ON legacy_x.player_checks (target_steam_id, status);
ALTER TABLE legacy_x.player_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.player_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.player_checks TO service_role;
NOTIFY pgrst, 'reload schema';
