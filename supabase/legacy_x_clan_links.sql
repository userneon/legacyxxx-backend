-- Links on a clan's page (owner request 2026-10-26): Discord, Facebook, YouTube, Twitch, Kick, Instagram, TikTok, a Steam group.
-- The leader sets them; the API only accepts https links on each platform's own host. Safe to re-run.
ALTER TABLE legacy_x.clans ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '{}'::jsonb;
NOTIFY pgrst, 'reload schema';
