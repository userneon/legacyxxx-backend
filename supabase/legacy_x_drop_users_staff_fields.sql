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
