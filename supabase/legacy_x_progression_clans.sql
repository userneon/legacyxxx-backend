BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.community_event_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS legacy_x.community_player_progression (
  user_id UUID PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  experience INTEGER NOT NULL DEFAULT 0 CHECK (experience >= 0),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  matches_played INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  last_match_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.community_match_experience (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES legacy_x.community_event_receipts(event_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE RESTRICT,
  clan_id UUID REFERENCES legacy_x.clans(id) ON DELETE SET NULL,
  xp_delta INTEGER NOT NULL CHECK (xp_delta >= 0),
  level_after INTEGER NOT NULL CHECK (level_after >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS legacy_x.clan_season_scores (
  season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE CASCADE,
  clan_id UUID NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  experience INTEGER NOT NULL DEFAULT 0 CHECK (experience >= 0),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  matches_played INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, clan_id)
);

CREATE INDEX IF NOT EXISTS community_progression_experience_idx
  ON legacy_x.community_player_progression (experience DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS community_match_experience_user_idx
  ON legacy_x.community_match_experience (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clan_season_scores_points_idx
  ON legacy_x.clan_season_scores (season_id, points DESC, experience DESC);

CREATE OR REPLACE FUNCTION legacy_x.community_level_from_experience(p_experience INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT GREATEST(1, FLOOR(SQRT(GREATEST(p_experience, 0) / 150.0))::INTEGER + 1);
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_community_map_result(
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
  v_receipt_id UUID;
  v_season_id UUID;
  v_team_key TEXT;
  v_team JSONB;
  v_player JSONB;
  v_stats JSONB;
  v_user_id UUID;
  v_clan_id UUID;
  v_outcome TEXT;
  v_kills INTEGER;
  v_assists INTEGER;
  v_headshots INTEGER;
  v_xp INTEGER;
  v_experience INTEGER;
  v_level INTEGER;
BEGIN
  IF p_plugin_id <> 'matchzy' THEN
    RAISE EXCEPTION 'Unsupported plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event', '') <> 'map_result' OR COALESCE(p_payload->>'event_id', '') <> p_event_id THEN
    RAISE EXCEPTION 'Only matching map_result events may change community progression' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.community_event_receipts (plugin_id, event_id, event_type, payload)
  VALUES (p_plugin_id, p_event_id, 'map_result', p_payload)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING id INTO v_receipt_id;

  IF v_receipt_id IS NULL THEN
    RETURN jsonb_build_object('status', 'duplicate', 'event_id', p_event_id);
  END IF;

  SELECT id INTO v_season_id
  FROM legacy_x.rank_seasons
  WHERE slug = COALESCE(NULLIF(p_payload->>'season', ''), 'season-1');
  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'Unknown rank season' USING ERRCODE = '22023';
  END IF;

  FOREACH v_team_key IN ARRAY ARRAY['team1', 'team2'] LOOP
    v_team := p_payload -> v_team_key;
    v_outcome := CASE WHEN p_payload #>> '{winner,team}' = v_team_key THEN 'win' ELSE 'loss' END;

    FOR v_player IN SELECT value FROM jsonb_array_elements(COALESCE(v_team->'players', '[]'::jsonb)) LOOP
      v_stats := COALESCE(v_player->'stats', '{}'::jsonb);
      v_kills := COALESCE(NULLIF(v_stats->>'kills', '')::INTEGER, 0);
      v_assists := COALESCE(NULLIF(v_stats->>'assists', '')::INTEGER, 0);
      v_headshots := COALESCE(NULLIF(v_stats->>'headshot_kills', '')::INTEGER, 0);
      v_xp := LEAST(350, 100
        + CASE WHEN v_outcome = 'win' THEN 50 ELSE 0 END
        + LEAST(120, GREATEST(0, v_kills) * 4)
        + LEAST(50, GREATEST(0, v_assists) * 2)
        + LEAST(30, GREATEST(0, v_headshots)));

      INSERT INTO legacy_x.users (steam_id, username, avatar)
      VALUES (v_player->>'steamid', COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_player->>'steamid'), '')
      ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username
      RETURNING id INTO v_user_id;

      INSERT INTO legacy_x.player_stats (user_id, experience, last_played_at)
      VALUES (v_user_id, v_xp, now())
      ON CONFLICT (user_id) DO UPDATE SET
        experience = COALESCE(legacy_x.player_stats.experience, 0) + v_xp,
        last_played_at = now();

      INSERT INTO legacy_x.community_player_progression (user_id, experience, level, matches_played, last_match_at)
      VALUES (v_user_id, v_xp, legacy_x.community_level_from_experience(v_xp), 1, now())
      ON CONFLICT (user_id) DO UPDATE SET
        experience = legacy_x.community_player_progression.experience + v_xp,
        level = legacy_x.community_level_from_experience(legacy_x.community_player_progression.experience + v_xp),
        matches_played = legacy_x.community_player_progression.matches_played + 1,
        last_match_at = now(),
        updated_at = now()
      RETURNING experience, level INTO v_experience, v_level;

      UPDATE legacy_x.users SET level = v_level WHERE id = v_user_id;

      SELECT clan_id INTO v_clan_id FROM legacy_x.clan_members WHERE user_id = v_user_id LIMIT 1;
      IF v_clan_id IS NOT NULL THEN
        INSERT INTO legacy_x.clan_season_scores (season_id, clan_id, experience, points, matches_played, wins)
        VALUES (v_season_id, v_clan_id, v_xp, v_xp + CASE WHEN v_outcome = 'win' THEN 50 ELSE 0 END, 1, CASE WHEN v_outcome = 'win' THEN 1 ELSE 0 END)
        ON CONFLICT (season_id, clan_id) DO UPDATE SET
          experience = legacy_x.clan_season_scores.experience + v_xp,
          points = legacy_x.clan_season_scores.points + v_xp + CASE WHEN v_outcome = 'win' THEN 50 ELSE 0 END,
          matches_played = legacy_x.clan_season_scores.matches_played + 1,
          wins = legacy_x.clan_season_scores.wins + CASE WHEN v_outcome = 'win' THEN 1 ELSE 0 END,
          updated_at = now();
      END IF;

      INSERT INTO legacy_x.community_match_experience (event_id, user_id, season_id, clan_id, xp_delta, level_after)
      VALUES (p_event_id, v_user_id, v_season_id, v_clan_id, v_xp, v_level);
    END LOOP;
  END LOOP;

  UPDATE legacy_x.community_event_receipts SET processed_at = now() WHERE id = v_receipt_id;
  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, 'community.map_result.ingest', 'community_event', p_event_id, jsonb_build_object('seasonId', v_season_id));

  RETURN jsonb_build_object('status', 'processed', 'event_id', p_event_id, 'season_id', v_season_id);
END;
$$;

CREATE OR REPLACE VIEW legacy_x.community_experience_leaderboard AS
SELECT
  DENSE_RANK() OVER (ORDER BY cpp.experience DESC, cpp.matches_played DESC, cpp.updated_at ASC) AS rank,
  u.steam_id,
  u.username,
  cpp.level,
  cpp.experience,
  cpp.matches_played,
  cpp.last_match_at
FROM legacy_x.community_player_progression cpp
JOIN legacy_x.users u ON u.id = cpp.user_id;

CREATE OR REPLACE VIEW legacy_x.community_clan_leaderboard AS
SELECT
  rs.slug AS season_slug,
  DENSE_RANK() OVER (PARTITION BY css.season_id ORDER BY css.points DESC, css.experience DESC, css.wins DESC, css.updated_at ASC) AS rank,
  c.id AS clan_id,
  c.name,
  c.tag,
  c.region,
  css.points,
  css.experience,
  css.matches_played,
  css.wins,
  css.updated_at
FROM legacy_x.clan_season_scores css
JOIN legacy_x.rank_seasons rs ON rs.id = css.season_id
JOIN legacy_x.clans c ON c.id = css.clan_id;

CREATE OR REPLACE VIEW legacy_x.community_player_profiles AS
SELECT
  u.steam_id,
  u.username,
  u.avatar,
  COALESCE(cpp.level, u.level, 1) AS level,
  COALESCE(cpp.experience, ps.experience, 0) AS experience,
  COALESCE(rps.rating, 1000) AS rating,
  CASE WHEN rps.rating >= 1800 THEN 'legend' WHEN rps.rating >= 1500 THEN 'elite' WHEN rps.rating >= 1250 THEN 'veteran' WHEN rps.rating >= 1000 THEN 'contender' ELSE 'rookie' END AS rank_tier,
  c.id AS clan_id,
  c.name AS clan_name,
  c.tag AS clan_tag,
  cm.role AS clan_role
FROM legacy_x.users u
LEFT JOIN legacy_x.community_player_progression cpp ON cpp.user_id = u.id
LEFT JOIN legacy_x.player_stats ps ON ps.user_id = u.id
LEFT JOIN LATERAL (SELECT id FROM legacy_x.rank_seasons WHERE is_active ORDER BY created_at DESC LIMIT 1) active_season ON true
LEFT JOIN legacy_x.rank_player_seasons rps ON rps.user_id = u.id AND rps.season_id = active_season.id
LEFT JOIN LATERAL (SELECT clan_id, role FROM legacy_x.clan_members WHERE user_id = u.id LIMIT 1) cm ON true
LEFT JOIN legacy_x.clans c ON c.id = cm.clan_id;

ALTER TABLE legacy_x.community_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.community_player_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.community_match_experience ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_season_scores ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON legacy_x.community_event_receipts, legacy_x.community_player_progression, legacy_x.community_match_experience, legacy_x.clan_season_scores FROM anon, authenticated;
REVOKE ALL ON legacy_x.community_experience_leaderboard, legacy_x.community_clan_leaderboard, legacy_x.community_player_profiles FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.community_event_receipts, legacy_x.community_player_progression, legacy_x.community_match_experience, legacy_x.clan_season_scores TO service_role;
GRANT SELECT ON legacy_x.community_experience_leaderboard, legacy_x.community_clan_leaderboard, legacy_x.community_player_profiles TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.community_level_from_experience(INTEGER), legacy_x.ingest_community_map_result(TEXT, TEXT, JSONB) TO service_role;

COMMIT;
