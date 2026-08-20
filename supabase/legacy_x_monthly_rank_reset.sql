BEGIN;

ALTER TABLE legacy_x.rank_seasons ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE legacy_x.rank_seasons ADD COLUMN IF NOT EXISTS period_end DATE;

UPDATE legacy_x.rank_seasons
SET period_start = COALESCE(period_start, date_trunc('month', now() AT TIME ZONE 'UTC')::DATE)
WHERE is_active AND period_start IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rank_seasons_active_singleton_idx
  ON legacy_x.rank_seasons ((is_active))
  WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS rank_seasons_period_start_idx
  ON legacy_x.rank_seasons (period_start)
  WHERE period_start IS NOT NULL;

CREATE TABLE IF NOT EXISTS legacy_x.rank_season_archives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL UNIQUE REFERENCES legacy_x.rank_seasons(id) ON DELETE CASCADE,
  season_slug TEXT NOT NULL,
  period_start DATE,
  period_end DATE,
  closed_at TIMESTAMPTZ NOT NULL,
  leaderboard_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  clan_leaderboard_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.rank_season_rollovers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL UNIQUE,
  previous_season_id UUID REFERENCES legacy_x.rank_seasons(id) ON DELETE SET NULL,
  new_season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE RESTRICT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_source TEXT NOT NULL CHECK (execution_source IN ('scheduler', 'manual', 'migration'))
);

CREATE OR REPLACE FUNCTION legacy_x.active_rank_season()
RETURNS TABLE (id UUID, slug TEXT, name TEXT, period_start DATE, period_end DATE, created_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
  SELECT rs.id, rs.slug, rs.name, rs.period_start, rs.period_end, rs.created_at
  FROM legacy_x.rank_seasons rs
  WHERE rs.is_active
  ORDER BY rs.created_at DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION legacy_x.rollover_monthly_rank_season(
  p_now TIMESTAMPTZ DEFAULT now(),
  p_source TEXT DEFAULT 'scheduler'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_period_start DATE := date_trunc('month', p_now AT TIME ZONE 'UTC')::DATE;
  v_previous legacy_x.rank_seasons%ROWTYPE;
  v_new legacy_x.rank_seasons%ROWTYPE;
  v_slug TEXT := 'season-' || to_char(date_trunc('month', p_now AT TIME ZONE 'UTC'), 'YYYY-MM');
  v_leaderboard JSONB;
  v_clans JSONB;
BEGIN
  IF p_source NOT IN ('scheduler', 'manual', 'migration') THEN
    RAISE EXCEPTION 'Unsupported rollover source' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('legacy_x.monthly_rank_rollover'));

  SELECT * INTO v_previous
  FROM legacy_x.rank_seasons
  WHERE is_active
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_previous.period_start = v_period_start THEN
    RETURN jsonb_build_object('status', 'noop', 'season', v_previous.slug, 'period_start', v_period_start);
  END IF;

  INSERT INTO legacy_x.rank_seasons (slug, name, is_active, period_start)
  VALUES (v_slug, 'LEGACY-X ' || to_char(v_period_start, 'FMMonth YYYY'), false, v_period_start)
  ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
  RETURNING * INTO v_new;

  IF FOUND AND v_previous.id IS NOT NULL AND v_previous.id <> v_new.id THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(board)), '[]'::jsonb) INTO v_leaderboard
    FROM (
      SELECT rank, steam_id, username, rating, tier, matches_played, wins, losses, kills, deaths, assists, last_match_at
      FROM legacy_x.rank_leaderboard
      WHERE season_slug = v_previous.slug
      ORDER BY rank ASC
      LIMIT 500
    ) board;

    SELECT COALESCE(jsonb_agg(to_jsonb(board)), '[]'::jsonb) INTO v_clans
    FROM (
      SELECT rank, clan_id, name, tag, region, points, experience, matches_played, wins, updated_at
      FROM legacy_x.community_clan_leaderboard
      WHERE season_slug = v_previous.slug
      ORDER BY rank ASC
      LIMIT 500
    ) board;

    INSERT INTO legacy_x.rank_season_archives (
      season_id, season_slug, period_start, period_end, closed_at, leaderboard_snapshot, clan_leaderboard_snapshot
    ) VALUES (
      v_previous.id, v_previous.slug, v_previous.period_start, v_period_start - 1, p_now, v_leaderboard, v_clans
    ) ON CONFLICT (season_id) DO NOTHING;

    UPDATE legacy_x.rank_seasons
    SET is_active = false, closed_at = COALESCE(closed_at, p_now), period_end = COALESCE(period_end, v_period_start - 1)
    WHERE id = v_previous.id;
  END IF;

  UPDATE legacy_x.rank_seasons SET is_active = false WHERE is_active AND id <> v_new.id;
  UPDATE legacy_x.rank_seasons SET is_active = true, period_start = COALESCE(period_start, v_period_start), period_end = NULL, closed_at = NULL WHERE id = v_new.id;

  INSERT INTO legacy_x.rank_season_rollovers (period_start, previous_season_id, new_season_id, execution_source)
  VALUES (v_period_start, NULLIF(v_previous.id, v_new.id), v_new.id, p_source)
  ON CONFLICT (period_start) DO NOTHING;

  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('system', 'rank-season', 'rank.season.rollover', 'rank_season', v_new.id, jsonb_build_object('slug', v_new.slug, 'periodStart', v_period_start, 'source', p_source));

  RETURN jsonb_build_object('status', 'rolled_over', 'previous_season', v_previous.slug, 'season', v_new.slug, 'period_start', v_period_start);
END;
$$;

SELECT legacy_x.rollover_monthly_rank_season(now(), 'migration');

ALTER TABLE legacy_x.rank_season_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.rank_season_rollovers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.rank_season_archives, legacy_x.rank_season_rollovers FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.rank_season_archives, legacy_x.rank_season_rollovers TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.active_rank_season(), legacy_x.rollover_monthly_rank_season(TIMESTAMPTZ, TEXT) TO service_role;

COMMIT;
