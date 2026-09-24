-- Legacy-X rank system v1.0 (docs/design/RANK-SYSTEM.md).
--
-- One number per player — EXP — that goes up and down after each ranked match.
-- The formula lives in TypeScript (server/legacyX/ranking.ts); this migration gives it:
--   * the new 18-rank ladder (Recruit I … Legacy, 0 … 2300),
--   * a per-player, per-match EXP snapshot (exp_before / exp_delta / exp_after / exp_breakdown),
--   * one SQL function that applies every delta of a match atomically and idempotently,
--   * everyone starting at 1000 EXP (Operator I).
-- It retires the old "+500 per win, never lose EXP" ingestion and its action ledger.

BEGIN;

-- ── 1. Rank ladder ────────────────────────────────────────────────────────────
-- Two passes because slug, display_name and minimum_exp are each UNIQUE.
UPDATE legacy_x.competitive_rank_definitions
SET slug = 'tmp-' || rank_id, display_name = 'tmp ' || rank_id, minimum_exp = 100000 + rank_id;

UPDATE legacy_x.competitive_rank_definitions d
SET slug = v.slug,
    display_name = v.display_name,
    minimum_exp = v.minimum_exp,
    image_key = v.image_key,
    pro_league_eligible = v.rank_id >= 11
FROM (VALUES
  (1,  'recruit-i',    'Recruit I',    0,    'rank-01'),
  (2,  'recruit-ii',   'Recruit II',   600,  'rank-02'),
  (3,  'recruit-iii',  'Recruit III',  700,  'rank-03'),
  (4,  'recruit-iv',   'Recruit IV',   800,  'rank-04'),
  (5,  'recruit-v',    'Recruit V',    900,  'rank-05'),
  (6,  'recruit-vi',   'Recruit VI',   950,  'rank-06'),
  (7,  'operator-i',   'Operator I',   1000, 'rank-07'),
  (8,  'operator-ii',  'Operator II',  1100, 'rank-08'),
  (9,  'operator-iii', 'Operator III', 1200, 'rank-09'),
  (10, 'operator-iv',  'Operator IV',  1300, 'rank-10'),
  (11, 'vanguard-i',   'Vanguard I',   1400, 'rank-11'),
  (12, 'vanguard-ii',  'Vanguard II',  1500, 'rank-12'),
  (13, 'vanguard-iii', 'Vanguard III', 1600, 'rank-13'),
  (14, 'vanguard-iv',  'Vanguard IV',  1700, 'rank-14'),
  (15, 'ace-i',        'Ace I',        1800, 'rank-15'),
  (16, 'ace-ii',       'Ace II',       1950, 'rank-16'),
  (17, 'apex',         'Apex',         2100, 'rank-17'),
  (18, 'legacy',       'Legacy',       2300, 'rank-18')
) AS v(rank_id, slug, display_name, minimum_exp, image_key)
WHERE d.rank_id = v.rank_id;

-- ── 2. Progression: start at 1000, keep deaths for K/D ranking ───────────────
ALTER TABLE legacy_x.competitive_player_progression
  ALTER COLUMN current_exp SET DEFAULT 1000,
  ALTER COLUMN current_rank_id SET DEFAULT 7,
  ADD COLUMN IF NOT EXISTS deaths INTEGER NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  ADD COLUMN IF NOT EXISTS draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0);

-- Launch: every player starts at 1000 EXP / Operator I (progression was empty, nothing is lost).
UPDATE legacy_x.competitive_player_progression
SET current_exp = 1000, current_rank_id = 7, pro_league_unlocked = false, updated_at = now();
INSERT INTO legacy_x.competitive_player_progression (user_id, current_exp, current_rank_id)
SELECT u.id, 1000, 7 FROM legacy_x.users u
ON CONFLICT (user_id) DO NOTHING;
UPDATE legacy_x.users SET rank = 'Operator I', updated_at = now();

-- ── 3. Per-player EXP snapshot of each ranked match ──────────────────────────
CREATE TABLE IF NOT EXISTS legacy_x.competitive_match_exp (
  event_id TEXT NOT NULL REFERENCES legacy_x.competitive_event_receipts(event_id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  team_key TEXT NOT NULL CHECK (team_key IN ('team1', 'team2')),
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'draw', 'loss')),
  exp_before INTEGER NOT NULL CHECK (exp_before >= 0),
  exp_delta INTEGER NOT NULL CHECK (exp_delta BETWEEN -90 AND 90),
  exp_after INTEGER NOT NULL CHECK (exp_after >= 0),
  rank_before SMALLINT NOT NULL REFERENCES legacy_x.competitive_rank_definitions(rank_id),
  rank_after SMALLINT NOT NULL REFERENCES legacy_x.competitive_rank_definitions(rank_id),
  exp_breakdown JSONB NOT NULL,
  counts_as_ranked BOOLEAN NOT NULL,
  calculation_version TEXT NOT NULL CHECK (length(calculation_version) BETWEEN 3 AND 40),
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CHECK (exp_after = exp_before + exp_delta)
);
CREATE INDEX IF NOT EXISTS competitive_match_exp_user_created_idx ON legacy_x.competitive_match_exp (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS competitive_match_exp_match_idx ON legacy_x.competitive_match_exp (match_id);
ALTER TABLE legacy_x.competitive_match_exp ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.competitive_match_exp FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON legacy_x.competitive_match_exp TO service_role;

ALTER TABLE legacy_x.competitive_event_receipts
  ADD COLUMN IF NOT EXISTS calculation_version TEXT,
  ADD COLUMN IF NOT EXISTS summary JSONB;

-- ── 4. Apply one match: receipt + every player's delta, atomically, once ─────
-- p_players: [{ user_id, team_key, outcome, exp_before, exp_delta, exp_breakdown, counts_as_ranked,
--              pro_league_unlocked, kills, deaths, assists, headshot_kills, stats }]
-- The EXP was computed from exp_before; if any player's EXP moved since, the call fails with
-- 40001 so the caller recalculates instead of applying a stale delta.
CREATE OR REPLACE FUNCTION legacy_x.apply_competitive_match_exp(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_match_id UUID,
  p_calculation_version TEXT,
  p_summary JSONB,
  p_players JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $$
DECLARE
  v_player JSONB;
  v_user_id UUID;
  v_before INTEGER;
  v_delta INTEGER;
  v_after INTEGER;
  v_current INTEGER;
  v_prev_unlocked BOOLEAN;
  v_rank_before SMALLINT;
  v_rank_after SMALLINT;
  v_rank_name TEXT;
  v_counts BOOLEAN;
  v_outcome TEXT;
  v_unlocked BOOLEAN;
  v_applied INTEGER := 0;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN
    RAISE EXCEPTION 'Only legacyx-match-core may apply competitive EXP' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_players) <> 'array' THEN
    RAISE EXCEPTION 'players must be an array' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.competitive_event_receipts (event_id, plugin_id, match_id, payload, calculation_version, summary)
  VALUES (p_event_id, p_plugin_id, p_match_id, jsonb_build_object('players', p_players), p_calculation_version, p_summary)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'event_id', p_event_id);
  END IF;

  PERFORM 1 FROM legacy_x.core_matches WHERE id = p_match_id AND state = 'FINISHED' AND final_event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'competitive EXP requires the stored final Match Core event' USING ERRCODE = '22023';
  END IF;

  FOR v_player IN SELECT value FROM jsonb_array_elements(p_players) ORDER BY value ->> 'user_id' LOOP
    v_user_id := (v_player ->> 'user_id')::UUID;
    v_before := (v_player ->> 'exp_before')::INTEGER;
    v_delta := (v_player ->> 'exp_delta')::INTEGER;
    v_counts := COALESCE((v_player ->> 'counts_as_ranked')::BOOLEAN, false);
    v_outcome := v_player ->> 'outcome';

    INSERT INTO legacy_x.competitive_player_progression (user_id) VALUES (v_user_id) ON CONFLICT (user_id) DO NOTHING;
    SELECT current_exp, pro_league_unlocked INTO v_current, v_prev_unlocked
    FROM legacy_x.competitive_player_progression WHERE user_id = v_user_id FOR UPDATE;
    IF v_current <> v_before THEN
      RAISE EXCEPTION 'EXP for % changed since the calculation', v_user_id USING ERRCODE = '40001';
    END IF;

    v_after := GREATEST(0, v_before + v_delta);
    SELECT rank_id INTO v_rank_before FROM legacy_x.competitive_rank_for_exp(v_before);
    SELECT rank_id, display_name INTO v_rank_after, v_rank_name FROM legacy_x.competitive_rank_for_exp(v_after);
    -- Pro League opens at 1400 and is only taken away below 1350.
    v_unlocked := v_after >= 1400 OR (v_prev_unlocked AND v_after >= 1350);

    INSERT INTO legacy_x.competitive_match_exp (
      event_id, match_id, user_id, team_key, outcome, exp_before, exp_delta, exp_after,
      rank_before, rank_after, exp_breakdown, counts_as_ranked, calculation_version, stats
    ) VALUES (
      p_event_id, p_match_id, v_user_id, v_player ->> 'team_key', v_outcome, v_before, v_after - v_before, v_after,
      v_rank_before, v_rank_after, COALESCE(v_player -> 'exp_breakdown', '{}'::jsonb), v_counts, p_calculation_version,
      COALESCE(v_player -> 'stats', '{}'::jsonb)
    );

    UPDATE legacy_x.competitive_player_progression SET
      current_exp = v_after,
      current_rank_id = v_rank_after,
      pro_league_unlocked = v_unlocked,
      matches_completed = matches_completed + CASE WHEN v_counts THEN 1 ELSE 0 END,
      wins = wins + CASE WHEN v_counts AND v_outcome = 'win' THEN 1 ELSE 0 END,
      losses = losses + CASE WHEN v_counts AND v_outcome = 'loss' THEN 1 ELSE 0 END,
      draws = draws + CASE WHEN v_counts AND v_outcome = 'draw' THEN 1 ELSE 0 END,
      kills = kills + CASE WHEN v_counts THEN GREATEST(0, COALESCE((v_player ->> 'kills')::INTEGER, 0)) ELSE 0 END,
      deaths = deaths + CASE WHEN v_counts THEN GREATEST(0, COALESCE((v_player ->> 'deaths')::INTEGER, 0)) ELSE 0 END,
      assists = assists + CASE WHEN v_counts THEN GREATEST(0, COALESCE((v_player ->> 'assists')::INTEGER, 0)) ELSE 0 END,
      headshot_kills = headshot_kills + CASE WHEN v_counts THEN GREATEST(0, COALESCE((v_player ->> 'headshot_kills')::INTEGER, 0)) ELSE 0 END,
      last_match_at = now(),
      updated_at = now()
    WHERE user_id = v_user_id;

    -- Display-only copy of the rank name on the user row.
    UPDATE legacy_x.users SET rank = v_rank_name, updated_at = now() WHERE id = v_user_id;
    v_applied := v_applied + 1;
  END LOOP;

  UPDATE legacy_x.competitive_event_receipts SET processed_at = now() WHERE event_id = p_event_id;
  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, 'competitive.exp.match.apply', 'competitive_match', p_match_id,
          jsonb_build_object('eventId', p_event_id, 'players', v_applied, 'version', p_calculation_version, 'summary', p_summary));
  RETURN jsonb_build_object('status', 'processed', 'event_id', p_event_id, 'match_id', p_match_id, 'players', v_applied);
END;
$$;
REVOKE ALL ON FUNCTION legacy_x.apply_competitive_match_exp(TEXT, TEXT, UUID, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.apply_competitive_match_exp(TEXT, TEXT, UUID, TEXT, JSONB, JSONB) TO service_role;

-- ── 5. Read models: players without a row still show as 1000 / Operator I ────
DROP VIEW IF EXISTS legacy_x.competitive_leaderboard;
CREATE VIEW legacy_x.competitive_leaderboard WITH (security_invoker = true) AS
WITH base AS (
  SELECT u.id AS user_id, u.steam_id, u.username, u.avatar, u.created_at,
         COALESCE(cp.current_exp, 1000) AS current_exp,
         COALESCE(cp.pro_league_unlocked, false) AS pro_league_unlocked,
         COALESCE(cp.matches_completed, 0) AS matches_completed,
         COALESCE(cp.wins, 0) AS wins,
         COALESCE(cp.losses, 0) AS losses,
         COALESCE(cp.kills, 0) AS kills,
         COALESCE(cp.deaths, 0) AS deaths,
         COALESCE(cp.assists, 0) AS assists,
         COALESCE(cp.headshot_kills, 0) AS headshot_kills,
         cp.last_match_at,
         COALESCE(ps.played_hours, 0::numeric) AS played_hours
  FROM legacy_x.users u
  LEFT JOIN legacy_x.competitive_player_progression cp ON cp.user_id = u.id
  LEFT JOIN legacy_x.player_stats ps ON ps.user_id = u.id
)
SELECT row_number() OVER (ORDER BY b.current_exp DESC, b.wins DESC, b.kills DESC, b.created_at, b.user_id) AS position,
       b.user_id, b.steam_id, b.username, b.avatar, b.current_exp,
       rd.rank_id, rd.slug AS rank_slug, rd.display_name AS rank_name, rd.image_key AS rank_image_key,
       b.pro_league_unlocked, b.matches_completed, b.wins, b.losses, b.kills, b.assists, b.headshot_kills,
       b.last_match_at, b.deaths,
       CASE WHEN b.deaths > 0 THEN round(b.kills::numeric / b.deaths, 2) ELSE b.kills::numeric END AS kd_ratio,
       CASE WHEN b.matches_completed > 0 THEN round(b.wins::numeric / b.matches_completed, 4) ELSE 0 END AS win_rate,
       b.played_hours
FROM base b
CROSS JOIN LATERAL legacy_x.competitive_rank_for_exp(b.current_exp) r
JOIN legacy_x.competitive_rank_definitions rd ON rd.rank_id = r.rank_id;

DROP VIEW IF EXISTS legacy_x.competitive_player_profiles;
CREATE VIEW legacy_x.competitive_player_profiles WITH (security_invoker = true) AS
SELECT u.id AS user_id, u.steam_id, u.username, u.avatar,
       COALESCE(cpp.current_exp, 1000) AS current_exp,
       d.rank_id, d.slug AS rank_slug, d.display_name AS rank_name, d.image_key AS rank_image_key,
       COALESCE(cpp.pro_league_unlocked, false) AS pro_league_unlocked,
       COALESCE(cpp.matches_completed, 0) AS matches_completed,
       COALESCE(cpp.wins, 0) AS wins,
       COALESCE(cpp.losses, 0) AS losses,
       COALESCE(cpp.kills, 0) AS kills,
       COALESCE(cpp.deaths, 0) AS deaths,
       COALESCE(cpp.assists, 0) AS assists,
       COALESCE(cpp.headshot_kills, 0) AS headshot_kills,
       cpp.last_match_at,
       d.minimum_exp AS current_rank_min_exp,
       next_d.rank_id AS next_rank_id,
       next_d.display_name AS next_rank_name,
       next_d.minimum_exp AS next_rank_min_exp
FROM legacy_x.users u
LEFT JOIN legacy_x.competitive_player_progression cpp ON cpp.user_id = u.id
CROSS JOIN LATERAL legacy_x.competitive_rank_for_exp(COALESCE(cpp.current_exp, 1000)) r
JOIN legacy_x.competitive_rank_definitions d ON d.rank_id = r.rank_id
LEFT JOIN legacy_x.competitive_rank_definitions next_d ON next_d.rank_id = d.rank_id + 1;

GRANT SELECT ON legacy_x.competitive_leaderboard, legacy_x.competitive_player_profiles TO service_role;

-- ── 6. Retire the old ingestion ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS legacy_x.competitive_metric(JSONB, TEXT, INTEGER);
DROP TABLE IF EXISTS legacy_x.competitive_exp_ledger;

COMMIT;
