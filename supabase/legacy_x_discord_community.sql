-- Discord community stats for the Leaders → Boosters page: how many times a Discord member boosted the server and how many
-- people joined through their invites. The Discord bot (plugin token with discord:link) writes them; the site shows them only
-- for members who linked Discord to a LEGACY-X profile. Only the Root API (service_role) reads or writes this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.discord_community_stats (
  discord_id text PRIMARY KEY CHECK (discord_id ~ '^[0-9]{17,20}$'),
  boosts integer NOT NULL DEFAULT 0 CHECK (boosts >= 0),
  boosting_since timestamptz,
  invites integer NOT NULL DEFAULT 0 CHECK (invites >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.discord_community_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.discord_community_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.discord_community_stats TO service_role;
NOTIFY pgrst, 'reload schema';
