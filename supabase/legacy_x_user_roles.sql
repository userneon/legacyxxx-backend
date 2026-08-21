-- Canonical LEGACY-X user roles. `is_staff` remains temporarily for legacy
-- consumers, but it is derived from `role` and must not be treated as source of truth.
BEGIN;

ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS role TEXT;

UPDATE legacy_x.users
SET role = CASE WHEN is_staff THEN 'Admin' ELSE 'Player' END
WHERE role IS NULL
   OR role NOT IN ('Owner', 'Founder', 'Manager', 'Admin', 'Player', 'Designer', 'Developer');

ALTER TABLE legacy_x.users
  ALTER COLUMN role SET DEFAULT 'Player',
  ALTER COLUMN role SET NOT NULL;

ALTER TABLE legacy_x.users
  DROP CONSTRAINT IF EXISTS users_role_allowed;

ALTER TABLE legacy_x.users
  ADD CONSTRAINT users_role_allowed
  CHECK (role IN ('Owner', 'Founder', 'Manager', 'Admin', 'Player', 'Designer', 'Developer'));

CREATE INDEX IF NOT EXISTS users_role_idx ON legacy_x.users (role);

CREATE OR REPLACE FUNCTION legacy_x.sync_users_staff_from_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = legacy_x, public
AS $$
BEGIN
  NEW.is_staff := NEW.role <> 'Player';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_sync_staff_from_role ON legacy_x.users;
CREATE TRIGGER users_sync_staff_from_role
BEFORE INSERT OR UPDATE OF role ON legacy_x.users
FOR EACH ROW
EXECUTE FUNCTION legacy_x.sync_users_staff_from_role();

UPDATE legacy_x.users
SET is_staff = role <> 'Player'
WHERE is_staff IS DISTINCT FROM (role <> 'Player');

COMMIT;
