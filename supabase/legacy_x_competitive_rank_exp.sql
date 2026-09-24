-- LEGACY-X competitive 18-rank EXP authority.
-- Additive rollout: legacy seasonal rating and community progression stay readable
-- but are not mutated by this function.

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
  (1, 'silver-i', 'Silver I', 0, 'rank-01', false),
  (2, 'silver-ii', 'Silver II', 1000, 'rank-02', false),
  (3, 'silver-iii', 'Silver III', 2200, 'rank-03', false),
  (4, 'silver-iv', 'Silver IV', 3600, 'rank-04', false),
  (5, 'silver-elite', 'Silver Elite', 5200, 'rank-05', false),
  (6, 'silver-elite-master', 'Silver Elite Master', 7000, 'rank-06', false),
  (7, 'gold-nova-i', 'Gold Nova I', 9000, 'rank-07', false),
  (8, 'gold-nova-ii', 'Gold Nova II', 11500, 'rank-08', false),
  (9, 'gold-nova-iii', 'Gold Nova III', 14500, 'rank-09', false),
  (10, 'gold-nova-master', 'Gold Nova Master', 18000, 'rank-10', false),
  (11, 'master-guardian-i', 'Master Guardian I', 22000, 'rank-11', true),
  (12, 'master-guardian-ii', 'Master Guardian II', 26500, 'rank-12', true),
  (13, 'master-guardian-elite', 'Master Guardian Elite', 31500, 'rank-13', true),
  (14, 'distinguished-master-guardian', 'Distinguished Master Guardian', 37000, 'rank-14', true),
  (15, 'legendary-eagle', 'Legendary Eagle', 43000, 'rank-15', true),
  (16, 'legendary-eagle-master', 'Legendary Eagle Master', 50000, 'rank-16', true),
  (17, 'supreme-master-first-class', 'Supreme Master First Class', 58000, 'rank-17', true),
  (18, 'global-elite', 'Global Elite', 67000, 'rank-18', true)
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

CREATE TABLE IF NOT EXISTS legacy_x.competitive_exp_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES legacy_x.competitive_event_receipts(event_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'match_win', 'match_loss', 'round_win', 'kill', 'assist', 'headshot_kill',
    'mvp', 'bomb_plant', 'bomb_defuse', 'bomb_explode', 'hostage_rescue',
    'clutch', 'first_kill', 'multi_kill_3plus', 'ace'
  )),
  exp_amount INTEGER NOT NULL CHECK (exp_amount > 0 AND exp_amount <= 20000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id, action)
);

CREATE INDEX IF NOT EXISTS competitive_progression_exp_idx
  ON legacy_x.competitive_player_progression (current_exp DESC, updated_at ASC);
CREATE INDEX IF NOT EXISTS competitive_exp_ledger_user_idx
  ON legacy_x.competitive_exp_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS competitive_exp_ledger_match_idx
  ON legacy_x.competitive_exp_ledger (match_id, created_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.competitive_metric(p_stats JSONB, p_key TEXT, p_cap INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw TEXT;
  v_value INTEGER;
BEGIN
  v_raw := NULLIF(COALESCE(p_stats ->> p_key, ''), '');
  IF v_raw IS NULL THEN RETURN 0; END IF;
  IF v_raw !~ '^\d+$' THEN
    RAISE EXCEPTION 'competitive stat % must be a non-negative integer', p_key USING ERRCODE = '22023';
  END IF;
  v_value := v_raw::INTEGER;
  IF v_value > p_cap THEN
    RAISE EXCEPTION 'competitive stat % exceeds validated cap', p_key USING ERRCODE = '22023';
  END IF;
  RETURN v_value;
END;
$$;

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

CREATE OR REPLACE FUNCTION legacy_x.ingest_competitive_match_result(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_match_id UUID;
  v_match legacy_x.core_matches%ROWTYPE;
  v_competitive JSONB;
  v_team_key TEXT;
  v_team JSONB;
  v_player JSONB;
  v_stats JSONB;
  v_user_id UUID;
  v_role TEXT;
  v_player_team TEXT;
  v_steam_id TEXT;
  v_winner TEXT;
  v_round_wins INTEGER;
  v_total_rounds INTEGER := 0;
  v_kills INTEGER;
  v_assists INTEGER;
  v_headshots INTEGER;
  v_mvps INTEGER;
  v_bomb_plants INTEGER;
  v_bomb_defuses INTEGER;
  v_bomb_explodes INTEGER;
  v_hostage_rescues INTEGER;
  v_clutches INTEGER;
  v_first_kills INTEGER;
  v_multi_kills INTEGER;
  v_aces INTEGER;
  v_total_exp INTEGER;
  v_current_exp INTEGER;
  v_rank_id SMALLINT;
  v_rank_name TEXT;
  v_pro BOOLEAN;
  v_action TEXT;
  v_amount INTEGER;
  v_rewarded_players INTEGER := 0;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN
    RAISE EXCEPTION 'Only legacyx-match-core may award competitive EXP' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload ->> 'event_id', '') <> p_event_id OR COALESCE(p_payload ->> 'event_type', '') <> 'result_final' THEN
    RAISE EXCEPTION 'competitive EXP requires a matching Match Core result_final event' USING ERRCODE = '22023';
  END IF;

  v_match_id := (p_payload ->> 'match_id')::UUID;
  v_competitive := p_payload #> '{result,competitive_result}';
  IF v_competitive IS NULL OR jsonb_typeof(v_competitive) <> 'object' THEN
    RAISE EXCEPTION 'competitive_result is required' USING ERRCODE = '22023';
  END IF;
  IF COALESCE((v_competitive ->> 'schema_version')::INTEGER, 0) <> 1
     OR COALESCE((v_competitive ->> 'reward_eligible')::BOOLEAN, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'competitive_result is not eligible' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.competitive_event_receipts (event_id, plugin_id, match_id, payload)
  VALUES (p_event_id, p_plugin_id, v_match_id, p_payload)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'event_id', p_event_id);
  END IF;

  SELECT * INTO v_match
  FROM legacy_x.core_matches
  WHERE id = v_match_id
  FOR UPDATE;
  IF NOT FOUND OR v_match.state <> 'FINISHED' OR v_match.final_event_id <> p_event_id THEN
    RAISE EXCEPTION 'competitive EXP requires the stored final Match Core event' USING ERRCODE = '22023';
  END IF;
  IF (SELECT COUNT(*) FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND eligible_for_rewards) <> 10
     OR EXISTS (SELECT 1 FROM legacy_x.core_match_slots WHERE match_id = v_match_id AND active_role = 'fill') THEN
    RAISE EXCEPTION 'competitive EXP requires ten original eligible players and no fill player' USING ERRCODE = '22023';
  END IF;

  v_winner := COALESCE(v_competitive ->> 'winner_team', '');
  IF v_winner NOT IN ('team1', 'team2') THEN
    RAISE EXCEPTION 'competitive result requires one winning team' USING ERRCODE = '22023';
  END IF;

  FOR v_team_key IN SELECT unnest(ARRAY['team1', 'team2']) LOOP
    v_team := v_competitive -> v_team_key;
    IF v_team IS NULL OR jsonb_typeof(v_team -> 'players') <> 'array' OR jsonb_array_length(v_team -> 'players') <> 5 THEN
      RAISE EXCEPTION 'competitive result requires exactly five players per team' USING ERRCODE = '22023';
    END IF;
    v_round_wins := legacy_x.competitive_metric(v_team, 'round_wins', 32);
    v_total_rounds := v_total_rounds + v_round_wins;

    FOR v_player IN SELECT value FROM jsonb_array_elements(v_team -> 'players') LOOP
      v_steam_id := COALESCE(v_player ->> 'steam_id', v_player ->> 'steamid');
      IF v_steam_id !~ '^\d{15,20}$' THEN
        RAISE EXCEPTION 'competitive player SteamID is invalid' USING ERRCODE = '22023';
      END IF;
      SELECT cmp.user_id, cmp.team_key, u.role INTO v_user_id, v_player_team, v_role
      FROM legacy_x.core_match_participants cmp
      JOIN legacy_x.users u ON u.id = cmp.user_id
      WHERE cmp.match_id = v_match_id AND cmp.steam_id = v_steam_id AND cmp.eligible_for_rewards
      FOR UPDATE;
      IF NOT FOUND OR v_player_team <> v_team_key THEN
        RAISE EXCEPTION 'competitive payload roster does not match Match Core roster' USING ERRCODE = '22023';
      END IF;
      -- Owner accounts never receive competitive state, history, or rewards.
      IF v_role = 'Owner' THEN CONTINUE; END IF;

      v_stats := COALESCE(v_player -> 'stats', '{}'::JSONB);
      v_kills := legacy_x.competitive_metric(v_stats, 'kills', 120);
      v_assists := legacy_x.competitive_metric(v_stats, 'assists', 100);
      v_headshots := legacy_x.competitive_metric(v_stats, 'headshot_kills', v_kills);
      v_mvps := legacy_x.competitive_metric(v_stats, 'mvps', 32);
      v_bomb_plants := legacy_x.competitive_metric(v_stats, 'bomb_plants', 32);
      v_bomb_defuses := legacy_x.competitive_metric(v_stats, 'bomb_defuses', 32);
      v_bomb_explodes := legacy_x.competitive_metric(v_stats, 'bomb_explodes', 32);
      v_hostage_rescues := legacy_x.competitive_metric(v_stats, 'hostage_rescues', 32);
      v_clutches := legacy_x.competitive_metric(v_stats, 'clutches', 32);
      v_first_kills := legacy_x.competitive_metric(v_stats, 'first_kills', 32);
      v_multi_kills := legacy_x.competitive_metric(v_stats, 'multi_kills_3plus', 32);
      v_aces := legacy_x.competitive_metric(v_stats, 'aces', 32);

      v_total_exp := 0;
      FOR v_action, v_amount IN
        SELECT * FROM (VALUES
          (CASE WHEN v_team_key = v_winner THEN 'match_win' ELSE 'match_loss' END, CASE WHEN v_team_key = v_winner THEN 500 ELSE 200 END),
          ('round_win', v_round_wins * 25),
          ('kill', v_kills * 20),
          ('assist', v_assists * 10),
          ('headshot_kill', v_headshots * 10),
          ('mvp', v_mvps * 50),
          ('bomb_plant', v_bomb_plants * 20),
          ('bomb_defuse', v_bomb_defuses * 30),
          ('bomb_explode', v_bomb_explodes * 30),
          ('hostage_rescue', v_hostage_rescues * 30),
          ('clutch', v_clutches * 50),
          ('first_kill', v_first_kills * 15),
          ('multi_kill_3plus', v_multi_kills * 30),
          ('ace', v_aces * 100)
        ) AS rewards(action, amount)
      LOOP
        IF v_amount > 0 THEN
          INSERT INTO legacy_x.competitive_exp_ledger (event_id, user_id, match_id, action, exp_amount, metadata)
          VALUES (p_event_id, v_user_id, v_match_id, v_action, v_amount, jsonb_build_object('team', v_team_key, 'winner', v_winner, 'stats', v_stats));
          v_total_exp := v_total_exp + v_amount;
        END IF;
      END LOOP;

      SELECT current_exp INTO v_current_exp
      FROM legacy_x.competitive_player_progression
      WHERE user_id = v_user_id
      FOR UPDATE;
      v_current_exp := GREATEST(0, COALESCE(v_current_exp, 0) + v_total_exp);
      SELECT rank_id, display_name, pro_league_eligible
      INTO v_rank_id, v_rank_name, v_pro
      FROM legacy_x.competitive_rank_for_exp(v_current_exp);

      INSERT INTO legacy_x.competitive_player_progression (
        user_id, current_exp, current_rank_id, pro_league_unlocked, matches_completed, wins, losses,
        kills, assists, headshot_kills, last_match_at
      ) VALUES (
        v_user_id, v_current_exp, v_rank_id, v_pro, 1,
        CASE WHEN v_team_key = v_winner THEN 1 ELSE 0 END,
        CASE WHEN v_team_key = v_winner THEN 0 ELSE 1 END,
        v_kills, v_assists, v_headshots, now()
      ) ON CONFLICT (user_id) DO UPDATE SET
        current_exp = EXCLUDED.current_exp,
        current_rank_id = EXCLUDED.current_rank_id,
        pro_league_unlocked = EXCLUDED.pro_league_unlocked,
        matches_completed = legacy_x.competitive_player_progression.matches_completed + 1,
        wins = legacy_x.competitive_player_progression.wins + EXCLUDED.wins,
        losses = legacy_x.competitive_player_progression.losses + EXCLUDED.losses,
        kills = legacy_x.competitive_player_progression.kills + EXCLUDED.kills,
        assists = legacy_x.competitive_player_progression.assists + EXCLUDED.assists,
        headshot_kills = legacy_x.competitive_player_progression.headshot_kills + EXCLUDED.headshot_kills,
        last_match_at = now(),
        updated_at = now();

      -- Compatibility field only. Canonical EXP/rank remains the competitive tables above.
      UPDATE legacy_x.users SET rank = v_rank_name, updated_at = now() WHERE id = v_user_id;
      v_rewarded_players := v_rewarded_players + 1;
    END LOOP;
  END LOOP;

  IF v_total_rounds < 13 THEN
    RAISE EXCEPTION 'competitive result is too short for rewards' USING ERRCODE = '22023';
  END IF;
  UPDATE legacy_x.competitive_event_receipts SET processed_at = now() WHERE event_id = p_event_id;
  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, 'competitive.exp.match.ingest', 'competitive_match', v_match_id, jsonb_build_object('eventId', p_event_id, 'playersRewarded', v_rewarded_players));
  RETURN jsonb_build_object('status', 'processed', 'event_id', p_event_id, 'match_id', v_match_id, 'players_rewarded', v_rewarded_players);
END;
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
ALTER TABLE legacy_x.competitive_exp_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.competitive_rank_definitions, legacy_x.competitive_player_progression, legacy_x.competitive_event_receipts, legacy_x.competitive_exp_ledger FROM anon, authenticated;
REVOKE ALL ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard FROM anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.competitive_metric(JSONB, TEXT, INTEGER), legacy_x.competitive_rank_for_exp(INTEGER), legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.competitive_rank_definitions, legacy_x.competitive_player_progression, legacy_x.competitive_event_receipts, legacy_x.competitive_exp_ledger TO service_role;
GRANT SELECT ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.competitive_metric(JSONB, TEXT, INTEGER), legacy_x.competitive_rank_for_exp(INTEGER), legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB) TO service_role;
