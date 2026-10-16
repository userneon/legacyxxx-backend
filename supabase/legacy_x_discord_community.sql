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
-- Added later: the member's Discord profile, so the page can show who they are even before they link a LEGACY-X profile. Safe to re-run.
ALTER TABLE legacy_x.discord_community_stats ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '' CHECK (char_length(display_name) <= 64);
ALTER TABLE legacy_x.discord_community_stats ADD COLUMN IF NOT EXISTS username text NOT NULL DEFAULT '' CHECK (char_length(username) <= 64);
ALTER TABLE legacy_x.discord_community_stats ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT '' CHECK (avatar = '' OR avatar ~ '^https://cdn\.discordapp\.com/');
-- Added later: whether the member boosts right now (the bot lists the current boosters in each report). Safe to re-run.
ALTER TABLE legacy_x.discord_community_stats ADD COLUMN IF NOT EXISTS boosting boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
