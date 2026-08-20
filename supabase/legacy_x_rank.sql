BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.rank_seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,64}$'),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

INSERT INTO legacy_x.rank_seasons (slug, name, is_active)
VALUES ('season-1', 'LEGACY-X Season 1', true)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS legacy_x.plugin_event_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS legacy_x.rank_player_seasons (
  season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1000 CHECK (rating >= 0),
  matches_played INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  kills INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  deaths INTEGER NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  assists INTEGER NOT NULL DEFAULT 0 CHECK (assists >= 0),
  last_match_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, user_id)
);

CREATE TABLE IF NOT EXISTS legacy_x.rank_match_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES legacy_x.plugin_event_receipts(event_id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  match_external_id TEXT NOT NULL,
  map_number INTEGER NOT NULL CHECK (map_number >= 0),
  map_name TEXT NOT NULL,
  team_key TEXT NOT NULL CHECK (team_key IN ('team1', 'team2')),
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'loss')),
  score_for INTEGER NOT NULL CHECK (score_for >= 0),
  score_against INTEGER NOT NULL CHECK (score_against >= 0),
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  headshot_kills INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  rating_delta INTEGER NOT NULL,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS rank_player_seasons_rating_idx
  ON legacy_x.rank_player_seasons (season_id, rating DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS rank_match_results_user_idx
  ON legacy_x.rank_match_results (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS plugin_event_receipts_plugin_received_idx
  ON legacy_x.plugin_event_receipts (plugin_id, received_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.ingest_rank_map_result(
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
  v_steam_id TEXT;
  v_name TEXT;
  v_kills INTEGER;
  v_deaths INTEGER;
  v_assists INTEGER;
  v_headshots INTEGER;
  v_score INTEGER;
  v_delta INTEGER;
  v_rating INTEGER;
  v_outcome TEXT;
  v_score_for INTEGER;
  v_score_against INTEGER;
BEGIN
  IF p_plugin_id <> 'matchzy' THEN
    RAISE EXCEPTION 'Unsupported plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event', '') <> 'map_result' THEN
    RAISE EXCEPTION 'Only map_result events may change rank' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event_id', '') <> p_event_id THEN
    RAISE EXCEPTION 'event_id mismatch' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.plugin_event_receipts (plugin_id, event_id, event_type, payload)
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
    v_score_for := COALESCE((v_team->>'score')::INTEGER, 0);
    v_score_against := COALESCE(((p_payload -> (CASE WHEN v_team_key = 'team1' THEN 'team2' ELSE 'team1' END))->>'score')::INTEGER, 0);

    FOR v_player IN SELECT value FROM jsonb_array_elements(COALESCE(v_team->'players', '[]'::jsonb)) LOOP
      v_steam_id := v_player->>'steamid';
      v_name := COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id);
      v_stats := COALESCE(v_player->'stats', '{}'::jsonb);
      v_kills := COALESCE(NULLIF(v_stats->>'kills', '')::INTEGER, 0);
      v_deaths := COALESCE(NULLIF(v_stats->>'deaths', '')::INTEGER, 0);
      v_assists := COALESCE(NULLIF(v_stats->>'assists', '')::INTEGER, 0);
      v_headshots := COALESCE(NULLIF(v_stats->>'headshot_kills', '')::INTEGER, 0);
      v_score := COALESCE(NULLIF(v_stats->>'score', '')::INTEGER, 0);
      v_delta := CASE WHEN v_outcome = 'win' THEN 25 ELSE -20 END
        + LEAST(12, GREATEST(-12, v_kills - v_deaths))
        + LEAST(4, FLOOR(v_assists / 2.0)::INTEGER)
        + LEAST(3, FLOOR(v_headshots / 3.0)::INTEGER);

      INSERT INTO legacy_x.users (steam_id, username, avatar)
      VALUES (v_steam_id, v_name, '')
      ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username
      RETURNING id INTO v_user_id;

      INSERT INTO legacy_x.rank_player_seasons (
        season_id, user_id, rating, matches_played, wins, losses, kills, deaths, assists, last_match_at
      ) VALUES (
        v_season_id, v_user_id, GREATEST(0, 1000 + v_delta), 1,
        CASE WHEN v_outcome = 'win' THEN 1 ELSE 0 END,
        CASE WHEN v_outcome = 'loss' THEN 1 ELSE 0 END,
        v_kills, v_deaths, v_assists, now()
      )
      ON CONFLICT (season_id, user_id) DO UPDATE SET
        rating = GREATEST(0, legacy_x.rank_player_seasons.rating + v_delta),
        matches_played = legacy_x.rank_player_seasons.matches_played + 1,
        wins = legacy_x.rank_player_seasons.wins + CASE WHEN v_outcome = 'win' THEN 1 ELSE 0 END,
        losses = legacy_x.rank_player_seasons.losses + CASE WHEN v_outcome = 'loss' THEN 1 ELSE 0 END,
        kills = legacy_x.rank_player_seasons.kills + v_kills,
        deaths = legacy_x.rank_player_seasons.deaths + v_deaths,
        assists = legacy_x.rank_player_seasons.assists + v_assists,
        last_match_at = now(),
        updated_at = now()
      RETURNING rating INTO v_rating;

      INSERT INTO legacy_x.rank_match_results (
        event_id, season_id, user_id, match_external_id, map_number, map_name, team_key, outcome,
        score_for, score_against, kills, deaths, assists, headshot_kills, score, rating_delta, stats
      ) VALUES (
        p_event_id, v_season_id, v_user_id, p_payload->>'match_id',
        COALESCE((p_payload->>'map_number')::INTEGER, 0), p_payload->>'map_name', v_team_key, v_outcome,
        v_score_for, v_score_against, v_kills, v_deaths, v_assists, v_headshots, v_score, v_delta, v_stats
      );
    END LOOP;
  END LOOP;

  UPDATE legacy_x.plugin_event_receipts SET processed_at = now() WHERE id = v_receipt_id;

  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, 'rank.map_result.ingest', 'rank_event', p_event_id, jsonb_build_object('seasonId', v_season_id, 'eventId', p_event_id));

  RETURN jsonb_build_object('status', 'processed', 'event_id', p_event_id, 'season_id', v_season_id);
END;
$$;

CREATE OR REPLACE VIEW legacy_x.rank_leaderboard AS
SELECT
  rs.slug AS season_slug,
  rs.name AS season_name,
  DENSE_RANK() OVER (PARTITION BY rps.season_id ORDER BY rps.rating DESC, rps.wins DESC, rps.kills DESC, rps.updated_at ASC) AS rank,
  u.steam_id,
  u.username,
  rps.rating,
  CASE
    WHEN rps.rating >= 1800 THEN 'legend'
    WHEN rps.rating >= 1500 THEN 'elite'
    WHEN rps.rating >= 1250 THEN 'veteran'
    WHEN rps.rating >= 1000 THEN 'contender'
    ELSE 'rookie'
  END AS tier,
  rps.matches_played,
  rps.wins,
  rps.losses,
  rps.kills,
  rps.deaths,
  rps.assists,
  ROUND(rps.kills::NUMERIC / NULLIF(rps.deaths, 0), 2) AS kd_ratio,
  rps.last_match_at
FROM legacy_x.rank_player_seasons rps
JOIN legacy_x.rank_seasons rs ON rs.id = rps.season_id
JOIN legacy_x.users u ON u.id = rps.user_id;

ALTER TABLE legacy_x.rank_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.plugin_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.rank_player_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.rank_match_results ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON legacy_x.rank_seasons, legacy_x.plugin_event_receipts, legacy_x.rank_player_seasons, legacy_x.rank_match_results FROM anon, authenticated;
REVOKE ALL ON legacy_x.rank_leaderboard FROM anon, authenticated;
GRANT USAGE ON SCHEMA legacy_x TO service_role;
GRANT SELECT, INSERT, UPDATE ON legacy_x.rank_seasons, legacy_x.plugin_event_receipts, legacy_x.rank_player_seasons, legacy_x.rank_match_results TO service_role;
GRANT SELECT ON legacy_x.rank_leaderboard TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_rank_map_result(TEXT, TEXT, JSONB) TO service_role;

COMMIT;
