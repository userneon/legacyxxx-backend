-- LEGACY-X canonical in-game admin policy.
-- Apply only after legacy_x_staff_panel.sql. Users remain identity-only.
ALTER TABLE legacy_x.staff
  ADD COLUMN IF NOT EXISTS game_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS stamina smallint NOT NULL DEFAULT 0 CHECK (stamina >= 0 AND stamina <= 1000),
  ADD COLUMN IF NOT EXISTS immunity smallint NOT NULL DEFAULT 0 CHECK (immunity >= 0 AND immunity <= 1000);

ALTER TABLE legacy_x.staff
  DROP CONSTRAINT IF EXISTS staff_immunity_check;
ALTER TABLE legacy_x.staff
  ADD CONSTRAINT staff_immunity_check CHECK (immunity >= 0 AND immunity <= 1000);

ALTER TABLE legacy_x.staff
  DROP CONSTRAINT IF EXISTS staff_game_permissions_array;
ALTER TABLE legacy_x.staff
  ADD CONSTRAINT staff_game_permissions_array CHECK (jsonb_typeof(game_permissions) = 'array');

CREATE INDEX IF NOT EXISTS staff_active_game_policy_idx
  ON legacy_x.staff (status, updated_at DESC)
  WHERE status = 'active';

-- The Root API service role is the only database principal that reads or writes this policy.
ALTER TABLE legacy_x.staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff TO service_role;
