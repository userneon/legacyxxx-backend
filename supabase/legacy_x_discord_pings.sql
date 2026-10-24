-- Which Discord pings a linked player wants (2026-10-24): one row per topic they switched on, none by default.
-- The Discord bot gives and takes the matching "Ping: …" role from the links list. Only the API (service_role) touches it. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.discord_pings (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  topic text NOT NULL CHECK (topic IN ('updates', 'news', 'live', 'play')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);
ALTER TABLE legacy_x.discord_pings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.discord_pings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON legacy_x.discord_pings TO service_role;

-- Whether a linked account is on the Discord server right now (2026-10-24), reported by the bot: NULL until it has looked.
ALTER TABLE legacy_x.discord_links ADD COLUMN IF NOT EXISTS in_guild boolean, ADD COLUMN IF NOT EXISTS in_guild_at timestamptz;
