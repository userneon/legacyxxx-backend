-- A number for each real match (owner request 2026-10-30): the game shows "Match #N", which used to be MatchZy's local id (it changed with every
-- restart and was different on every server). Now it counts the matches the site recorded: the first is 1, then 2, 3 ... on every server.
-- A match that failed to register takes no number (the number is given when the row is created). Safe to re-run.
CREATE SEQUENCE IF NOT EXISTS legacy_x.core_match_number_seq START 1;
ALTER TABLE legacy_x.core_matches ADD COLUMN IF NOT EXISTS match_number bigint NOT NULL DEFAULT nextval('legacy_x.core_match_number_seq');
CREATE UNIQUE INDEX IF NOT EXISTS core_matches_match_number_key ON legacy_x.core_matches (match_number);
NOTIFY pgrst, 'reload schema';
