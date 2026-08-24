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
  cpp.last_match_at,
  d.minimum_exp AS current_rank_min_exp,
  next_d.rank_id AS next_rank_id,
  next_d.display_name AS next_rank_name,
  next_d.minimum_exp AS next_rank_min_exp
FROM legacy_x.competitive_player_progression cpp
JOIN legacy_x.users u ON u.id = cpp.user_id AND u.role <> 'Owner'
JOIN legacy_x.competitive_rank_definitions d ON d.rank_id = cpp.current_rank_id
LEFT JOIN legacy_x.competitive_rank_definitions next_d ON next_d.rank_id = d.rank_id + 1;
