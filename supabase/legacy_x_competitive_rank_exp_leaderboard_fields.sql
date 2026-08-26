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
