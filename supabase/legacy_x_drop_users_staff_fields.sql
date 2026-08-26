-- LEGACY-X canonical staff model cleanup.
-- Prerequisite: deploy the role-free backend/frontend revision before executing.
-- This is intentionally destructive only for legacy users.role and users.is_staff.
-- A one-time backup is retained in legacy_x.users_staff_fields_backup_20260826.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.users_staff_fields_backup_20260826 (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  legacy_role text,
  legacy_is_staff boolean,
  captured_at timestamptz NOT NULL DEFAULT now()
);

-- to_jsonb keeps this statement re-runnable even if either legacy column is already absent.
INSERT INTO legacy_x.users_staff_fields_backup_20260826 (user_id, legacy_role, legacy_is_staff)
SELECT
  u.id,
  to_jsonb(u) ->> 'role',
  CASE
    WHEN to_jsonb(u) ->> 'is_staff' IN ('true', 'false')
      THEN (to_jsonb(u) ->> 'is_staff')::boolean
    ELSE NULL
  END
FROM legacy_x.users AS u
ON CONFLICT (user_id) DO NOTHING;

-- Rebuild the latest public competitive projections without users.role.
-- This must happen before DROP COLUMN because these views otherwise depend on it.
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
JOIN legacy_x.users u ON u.id = cpp.user_id
JOIN legacy_x.competitive_rank_definitions d ON d.rank_id = cpp.current_rank_id
LEFT JOIN legacy_x.competitive_rank_definitions next_d ON next_d.rank_id = d.rank_id + 1;

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

REVOKE ALL ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard FROM anon, authenticated;
GRANT SELECT ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard TO service_role;

DROP TRIGGER IF EXISTS users_sync_staff_from_role ON legacy_x.users;
DROP FUNCTION IF EXISTS legacy_x.sync_users_staff_from_role();
DROP INDEX IF EXISTS legacy_x.users_role_idx;
ALTER TABLE legacy_x.users DROP CONSTRAINT IF EXISTS users_role_allowed;
ALTER TABLE legacy_x.users DROP COLUMN IF EXISTS is_staff;
ALTER TABLE legacy_x.users DROP COLUMN IF EXISTS role;

COMMIT;

-- Non-sensitive verification.
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_schema = 'legacy_x'
--   AND table_name = 'users'
--   AND column_name IN ('role', 'is_staff');
-- Expected: zero rows.

-- Rollback only if the deployed role-free code has not yet been restarted.
-- ALTER TABLE legacy_x.users ADD COLUMN IF NOT EXISTS role text;
-- ALTER TABLE legacy_x.users ADD COLUMN IF NOT EXISTS is_staff boolean;
-- UPDATE legacy_x.users AS u
-- SET role = b.legacy_role,
--     is_staff = b.legacy_is_staff
-- FROM legacy_x.users_staff_fields_backup_20260826 AS b
-- WHERE b.user_id = u.id;
