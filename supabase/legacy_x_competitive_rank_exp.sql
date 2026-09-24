-- LEGACY-X competitive rank: base tables, the 18-rank ladder and the EXP -> rank lookup.
-- The EXP arithmetic lives in the API (server/legacyX/rank/exp.ts); legacy_x_rank_system_v1.sql adds the
-- per-match history table and the atomic apply function. The original "+500 per win, never lose EXP" ingestion
-- function and its ledger were retired by that migration and are no longer defined here.

CREATE TABLE IF NOT EXISTS legacy_x.competitive_rank_definitions (
  rank_id SMALLINT PRIMARY KEY CHECK (rank_id BETWEEN 1 AND 18),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  display_name TEXT NOT NULL UNIQUE,
  minimum_exp INTEGER NOT NULL UNIQUE CHECK (minimum_exp >= 0),
  image_key TEXT NOT NULL UNIQUE,
  pro_league_eligible BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO legacy_x.competitive_rank_definitions (rank_id, slug, display_name, minimum_exp, image_key, pro_league_eligible)
VALUES
  (1,  'recruit-i',    'Recruit I',    0,    'rank-01', false),
  (2,  'recruit-ii',   'Recruit II',   600,  'rank-02', false),
  (3,  'recruit-iii',  'Recruit III',  700,  'rank-03', false),
  (4,  'recruit-iv',   'Recruit IV',   800,  'rank-04', false),
  (5,  'recruit-v',    'Recruit V',    900,  'rank-05', false),
  (6,  'recruit-vi',   'Recruit VI',   950,  'rank-06', false),
  (7,  'operator-i',   'Operator I',   1000, 'rank-07', false),
  (8,  'operator-ii',  'Operator II',  1100, 'rank-08', false),
  (9,  'operator-iii', 'Operator III', 1200, 'rank-09', false),
  (10, 'operator-iv',  'Operator IV',  1300, 'rank-10', false),
  (11, 'vanguard-i',   'Vanguard I',   1400, 'rank-11', true),
  (12, 'vanguard-ii',  'Vanguard II',  1500, 'rank-12', true),
  (13, 'vanguard-iii', 'Vanguard III', 1600, 'rank-13', true),
  (14, 'vanguard-iv',  'Vanguard IV',  1700, 'rank-14', true),
  (15, 'ace-i',        'Ace I',        1800, 'rank-15', true),
  (16, 'ace-ii',       'Ace II',       1950, 'rank-16', true),
  (17, 'apex',         'Apex',         2100, 'rank-17', true),
  (18, 'legacy',       'Legacy',       2300, 'rank-18', true)
ON CONFLICT (rank_id) DO UPDATE SET
  slug = EXCLUDED.slug,
  display_name = EXCLUDED.display_name,
  minimum_exp = EXCLUDED.minimum_exp,
  image_key = EXCLUDED.image_key,
  pro_league_eligible = EXCLUDED.pro_league_eligible;

CREATE TABLE IF NOT EXISTS legacy_x.competitive_player_progression (
  user_id UUID PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  current_exp INTEGER NOT NULL DEFAULT 0 CHECK (current_exp >= 0),
  current_rank_id SMALLINT NOT NULL DEFAULT 1 REFERENCES legacy_x.competitive_rank_definitions(rank_id),
  pro_league_unlocked BOOLEAN NOT NULL DEFAULT false,
  matches_completed INTEGER NOT NULL DEFAULT 0 CHECK (matches_completed >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  kills INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  assists INTEGER NOT NULL DEFAULT 0 CHECK (assists >= 0),
  headshot_kills INTEGER NOT NULL DEFAULT 0 CHECK (headshot_kills >= 0),
  last_match_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.competitive_event_receipts (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 8 AND 220),
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 3 AND 120),
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE RESTRICT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS competitive_progression_exp_idx
  ON legacy_x.competitive_player_progression (current_exp DESC, updated_at ASC);

CREATE OR REPLACE FUNCTION legacy_x.competitive_rank_for_exp(p_exp INTEGER)
RETURNS TABLE (rank_id SMALLINT, display_name TEXT, image_key TEXT, pro_league_eligible BOOLEAN)
LANGUAGE sql
STABLE
AS $$
  SELECT d.rank_id, d.display_name, d.image_key, d.pro_league_eligible
  FROM legacy_x.competitive_rank_definitions d
  WHERE d.minimum_exp <= GREATEST(p_exp, 0)
  ORDER BY d.minimum_exp DESC
  LIMIT 1;
$$;

CREATE OR REPLACE VIEW legacy_x.competitive_player_profiles AS
SELECT
  cpp.user_id,
  u.steam_id,
  u.username,
  u.avatar,
  cpp.current_exp,
  d.rank_id,
  d.slug AS rank_slug,
  d.display_name AS rank_name,
  d.image_key AS rank_image_key,
  cpp.pro_league_unlocked,
  cpp.matches_completed,
  cpp.wins,
  cpp.losses,
  cpp.kills,
  cpp.assists,
  cpp.headshot_kills,
  cpp.last_match_at
FROM legacy_x.competitive_player_progression cpp
JOIN legacy_x.users u ON u.id = cpp.user_id
JOIN legacy_x.competitive_rank_definitions d ON d.rank_id = cpp.current_rank_id;

CREATE OR REPLACE VIEW legacy_x.competitive_leaderboard AS
SELECT
  DENSE_RANK() OVER (ORDER BY cp.current_exp DESC, cp.wins DESC, cp.kills DESC, cp.updated_at ASC) AS position,
  cp.user_id,
  u.steam_id,
  u.username,
  u.avatar,
  cp.current_exp,
  rd.rank_id,
  rd.slug AS rank_slug,
  rd.display_name AS rank_name,
  rd.image_key AS rank_image_key,
  cp.pro_league_unlocked,
  cp.matches_completed,
  cp.wins,
  cp.losses,
  cp.kills,
  cp.assists,
  cp.headshot_kills,
  cp.last_match_at,
  COALESCE(ps.deaths, 0) AS deaths,
  COALESCE(ps.kd_ratio, 0) AS kd_ratio,
  COALESCE(ps.played_hours, 0) AS played_hours
FROM legacy_x.competitive_player_progression cp
JOIN legacy_x.users u ON u.id = cp.user_id
JOIN legacy_x.competitive_rank_definitions rd ON rd.rank_id = cp.current_rank_id
LEFT JOIN legacy_x.player_stats ps ON ps.user_id = cp.user_id;

ALTER TABLE legacy_x.competitive_rank_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.competitive_player_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.competitive_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.competitive_rank_definitions, legacy_x.competitive_player_progression, legacy_x.competitive_event_receipts FROM anon, authenticated;
REVOKE ALL ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard FROM anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.competitive_rank_for_exp(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.competitive_rank_definitions, legacy_x.competitive_player_progression, legacy_x.competitive_event_receipts TO service_role;
GRANT SELECT ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.competitive_rank_for_exp(INTEGER) TO service_role;
