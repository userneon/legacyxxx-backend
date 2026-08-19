BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.replace_user_links(
  p_user_id UUID,
  p_links TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
BEGIN
  DELETE FROM legacy_x.user_links
  WHERE user_id = p_user_id;

  IF cardinality(p_links) > 0 THEN
    INSERT INTO legacy_x.user_links (user_id, url)
    SELECT p_user_id, link
    FROM unnest(p_links) AS link;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_player_match_result(
  p_plugin_id UUID,
  p_user_id UUID,
  p_match_id UUID,
  p_map TEXT,
  p_result legacy_x.match_result,
  p_score TEXT,
  p_kd TEXT,
  p_stats JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_history_id UUID;
BEGIN
  INSERT INTO legacy_x.player_match_history (user_id, match_id, map, result, score, kd)
  VALUES (p_user_id, p_match_id, p_map, p_result, p_score, p_kd)
  RETURNING id INTO v_history_id;

  IF p_stats IS NOT NULL THEN
    INSERT INTO legacy_x.player_stats (
      user_id, matches, wins, kills, deaths, headshots, kd_ratio, rating, experience, played_hours, last_played_at
    )
    VALUES (
      p_user_id,
      (p_stats->>'matches')::INTEGER,
      (p_stats->>'wins')::INTEGER,
      (p_stats->>'kills')::INTEGER,
      (p_stats->>'deaths')::INTEGER,
      (p_stats->>'headshots')::INTEGER,
      (p_stats->>'kd_ratio')::NUMERIC,
      (p_stats->>'rating')::NUMERIC,
      (p_stats->>'experience')::INTEGER,
      (p_stats->>'played_hours')::NUMERIC,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      matches = EXCLUDED.matches,
      wins = EXCLUDED.wins,
      kills = EXCLUDED.kills,
      deaths = EXCLUDED.deaths,
      headshots = EXCLUDED.headshots,
      kd_ratio = EXCLUDED.kd_ratio,
      rating = EXCLUDED.rating,
      experience = EXCLUDED.experience,
      played_hours = EXCLUDED.played_hours,
      last_played_at = EXCLUDED.last_played_at;
  END IF;

  INSERT INTO legacy_x.audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES (
    'plugin',
    p_plugin_id,
    'player_match_history.create',
    'player_match_history',
    v_history_id,
    jsonb_build_object('userId', p_user_id, 'matchId', p_match_id)
  );

  RETURN v_history_id;
END;
$$;

COMMIT;
