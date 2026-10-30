-- Clan Wars were removed (owner request 2026-10-30). Apply after the API without the war routes is live.
DROP TABLE IF EXISTS legacy_x.clan_wars;
ALTER TABLE legacy_x.clan_progress DROP COLUMN IF EXISTS war_rating;
ALTER TABLE legacy_x.clan_progress DROP COLUMN IF EXISTS war_wins;
ALTER TABLE legacy_x.clan_progress DROP COLUMN IF EXISTS war_losses;
ALTER TABLE legacy_x.clan_progress DROP COLUMN IF EXISTS war_draws;
