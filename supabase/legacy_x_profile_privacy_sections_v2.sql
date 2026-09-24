-- Profile "What others can see": the four sections are stats / matches / faceit / loadout.
-- The older per-stat values (kd, kills, recent_matches) stay allowed; the API maps them onto the
-- four sections when it reads them (server/legacyX/profileOverview.ts). Safe to re-run.
BEGIN;

ALTER TABLE legacy_x.users DROP CONSTRAINT IF EXISTS users_hidden_profile_sections_known;
ALTER TABLE legacy_x.users
  ADD CONSTRAINT users_hidden_profile_sections_known
  CHECK (hidden_profile_sections <@ ARRAY['stats', 'matches', 'faceit', 'loadout', 'kd', 'kills', 'recent_matches']::TEXT[]);

COMMIT;
