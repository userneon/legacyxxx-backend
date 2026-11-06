-- A player with an active ban is not on the ladder (owner request 2026-11-06): Leaders, Home's Top players and the EXP card's "place" all read this view, so
-- every place is counted without them. Nothing is deleted: when the ban is lifted (penalties.is_unbanned) or ends, the player is back with their EXP, rank
-- and stats, and the places below them move down again. An active ban is a `ban` penalty that is not lifted and is permanent or has not run out.
CREATE OR REPLACE VIEW legacy_x.competitive_leaderboard AS
 WITH base AS (
         SELECT u.id AS user_id,
            u.steam_id,
            u.username,
            u.avatar,
            u.created_at,
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
          WHERE NOT EXISTS (
            SELECT 1 FROM legacy_x.penalties p
            WHERE p.user_id = u.id AND p.type = 'ban' AND NOT p.is_unbanned
              AND (p.is_permanent OR p.expires_at IS NULL OR p.expires_at > now())
          )
        )
 SELECT row_number() OVER (ORDER BY b.current_exp DESC, b.wins DESC, b.kills DESC, b.created_at, b.user_id) AS "position",
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
        CASE
            WHEN b.deaths > 0 THEN round(b.kills::numeric / b.deaths::numeric, 2)
            ELSE b.kills::numeric
        END AS kd_ratio,
        CASE
            WHEN b.matches_completed > 0 THEN round(b.wins::numeric / b.matches_completed::numeric, 4)
            ELSE 0::numeric
        END AS win_rate,
    b.played_hours
   FROM base b
     CROSS JOIN LATERAL legacy_x.competitive_rank_for_exp(b.current_exp) r(rank_id, display_name, image_key, pro_league_eligible)
     JOIN legacy_x.competitive_rank_definitions rd ON rd.rank_id = r.rank_id;

-- Verification: a banned player must be missing here and back after the ban is lifted.
-- SELECT count(*) FROM legacy_x.competitive_leaderboard;
