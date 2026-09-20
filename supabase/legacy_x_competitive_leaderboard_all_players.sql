-- Leaders lists every registered player, ordered by experience.
--
-- The view was built from competitive_player_progression, so a player only appeared once the game
-- servers had written progression for them. With no progression rows at all the leaderboard was
-- empty even though the community had registered accounts. It now starts from users and treats a
-- missing progression row as a real zero: 0 EXP, no matches, and the first rank.
--
-- Position is row_number so every player holds one place on the ladder; ties fall back to wins,
-- kills and the older account.

CREATE OR REPLACE VIEW legacy_x.competitive_leaderboard AS
WITH base AS (
  SELECT
    u.id AS user_id,
    u.steam_id,
    u.username,
    u.avatar,
    u.created_at,
    COALESCE(cp.current_exp, 0) AS current_exp,
    COALESCE(cp.pro_league_unlocked, false) AS pro_league_unlocked,
    COALESCE(cp.matches_completed, 0) AS matches_completed,
    COALESCE(cp.wins, 0) AS wins,
    COALESCE(cp.losses, 0) AS losses,
    COALESCE(cp.kills, 0) AS kills,
    COALESCE(cp.assists, 0) AS assists,
    COALESCE(cp.headshot_kills, 0) AS headshot_kills,
    cp.last_match_at,
    cp.current_rank_id,
    COALESCE(ps.deaths, 0) AS deaths,
    COALESCE(ps.kd_ratio, 0::numeric) AS kd_ratio,
    COALESCE(ps.played_hours, 0::numeric) AS played_hours
  FROM legacy_x.users u
  LEFT JOIN legacy_x.competitive_player_progression cp ON cp.user_id = u.id
  LEFT JOIN legacy_x.player_stats ps ON ps.user_id = u.id
)
SELECT
  row_number() OVER (ORDER BY b.current_exp DESC, b.wins DESC, b.kills DESC, b.created_at, b.user_id) AS "position",
  b.user_id,
  b.steam_id,
  b.username,
  b.avatar,
  b.current_exp,
  rd.rank_id,
  rd.slug AS rank_slug,
  rd.display_name AS rank_name,
  rd.image_key AS rank_image_key,
  b.pro_league_unlocked,
  b.matches_completed,
  b.wins,
  b.losses,
  b.kills,
  b.assists,
  b.headshot_kills,
  b.last_match_at,
  b.deaths,
  b.kd_ratio,
  b.played_hours
FROM base b
-- A player with progression keeps the rank the server gave them; everyone else gets the rank their
-- experience earns, which for a new account is the first one.
JOIN LATERAL (
  SELECT d.*
  FROM legacy_x.competitive_rank_definitions d
  WHERE d.rank_id = COALESCE(
    b.current_rank_id,
    (
      SELECT dd.rank_id
      FROM legacy_x.competitive_rank_definitions dd
      WHERE dd.minimum_exp <= b.current_exp
      ORDER BY dd.minimum_exp DESC
      LIMIT 1
    )
  )
) rd ON true;

-- Verification: must return one row per registered player.
-- SELECT count(*) FROM legacy_x.competitive_leaderboard;
-- SELECT "position", username, current_exp, rank_name FROM legacy_x.competitive_leaderboard ORDER BY "position" LIMIT 20;
