-- A staff reply under a review (Admin and above) and the time a review was last edited by its author (owner request 2026-10-30).
ALTER TABLE legacy_x.feedback ADD COLUMN IF NOT EXISTS reply text;
ALTER TABLE legacy_x.feedback ADD COLUMN IF NOT EXISTS reply_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL;
ALTER TABLE legacy_x.feedback ADD COLUMN IF NOT EXISTS reply_by_name text;
ALTER TABLE legacy_x.feedback ADD COLUMN IF NOT EXISTS reply_role text;
ALTER TABLE legacy_x.feedback ADD COLUMN IF NOT EXISTS replied_at timestamptz;
ALTER TABLE legacy_x.feedback ADD COLUMN IF NOT EXISTS edited_at timestamptz;
