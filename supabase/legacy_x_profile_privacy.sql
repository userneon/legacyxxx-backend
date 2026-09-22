-- LEGACY-X profile privacy: boxes a player chose to hide from other players on their profile.
-- Additive only: a new column with an empty default, so existing profiles show everything as before.
-- Penalty history, SteamID, Steam link and rank are never hideable and have no entry here.

ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS hidden_profile_sections TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

ALTER TABLE legacy_x.users
  DROP CONSTRAINT IF EXISTS users_hidden_profile_sections_known;
ALTER TABLE legacy_x.users
  ADD CONSTRAINT users_hidden_profile_sections_known
  CHECK (hidden_profile_sections <@ ARRAY['kd', 'matches', 'kills', 'faceit', 'recent_matches']::TEXT[]);

COMMENT ON COLUMN legacy_x.users.hidden_profile_sections IS
  'Profile boxes hidden from other players: kd, matches, kills, faceit, recent_matches.';
