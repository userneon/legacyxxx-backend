-- LEGACY-X match rounds: per-round results from MatchZy `round_end` remote-log events.
-- Profile match details read these to draw the round timeline. Apply after legacy_x_rank.sql.
--
-- MatchZy quirks handled by the API layer rather than stored:
--   * `winner.team` in round_end is the team *leading* the map, not the round winner, so the round winner
--     is derived from the team score change between consecutive rounds.
--   * `winner.side` is the CS team number as text ("2" = T, "3" = CT) and is normalised to 't' / 'ct' on ingest.

CREATE TABLE IF NOT EXISTS legacy_x.match_rounds (
  match_external_id TEXT NOT NULL,
  map_number INTEGER NOT NULL CHECK (map_number >= 0),
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  winner_side TEXT CHECK (winner_side IN ('t', 'ct')),
  reason INTEGER,
  team1_score INTEGER NOT NULL CHECK (team1_score >= 0),
  team2_score INTEGER NOT NULL CHECK (team2_score >= 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_external_id, map_number, round_number)
);

-- Server-only table: the API reads it with the service role; browsers never query Supabase directly.
ALTER TABLE legacy_x.match_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.match_rounds FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.match_rounds TO service_role;

-- Match details look rank results up by match and map.
CREATE INDEX IF NOT EXISTS rank_match_results_match_map_idx
  ON legacy_x.rank_match_results (match_external_id, map_number);
