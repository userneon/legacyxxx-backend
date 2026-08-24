BEGIN;

-- `role` remains the only authorization source and is already constrained to
-- Owner, Founder, Manager, Admin, Player, Designer, and Developer.
DROP TRIGGER IF EXISTS users_sync_staff_from_role ON legacy_x.users;
DROP FUNCTION IF EXISTS legacy_x.sync_users_staff_from_role();

ALTER TABLE legacy_x.users
  DROP COLUMN IF EXISTS is_staff;

COMMIT;
