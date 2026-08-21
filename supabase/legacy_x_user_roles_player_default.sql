-- User decision: every Steam-authenticated account is a Player by default.
-- Elevated roles remain available only through an explicit manual update.
BEGIN;

UPDATE legacy_x.users
SET role = 'Player'
WHERE role IS DISTINCT FROM 'Player';

ALTER TABLE legacy_x.users
  ALTER COLUMN role SET DEFAULT 'Player',
  ALTER COLUMN role SET NOT NULL;

COMMIT;
