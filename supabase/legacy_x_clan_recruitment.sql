-- Clan recruitment (owner request 2026-10-24): a clan can switch recruitment on and ask up to three short questions; a player who asks to join
-- answers them and the leader or a manager reads the answers beside the request. With recruitment off nothing changes. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.clan_recruitment (
  clan_id uuid PRIMARY KEY REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) <= 3),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.clan_recruitment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_recruitment FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_recruitment TO service_role;
ALTER TABLE legacy_x.clan_join_requests ADD COLUMN IF NOT EXISTS answers jsonb;
NOTIFY pgrst, 'reload schema';
