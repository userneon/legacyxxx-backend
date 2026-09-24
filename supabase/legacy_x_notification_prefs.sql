-- Settings → Notifications: per-account switches for the bell (penalty notices are always on and
-- are not stored). The column already exists on the live project; this file keeps the repo
-- reproducible and is safe to re-run.
BEGIN;

ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{"tournaments": true, "rank_changes": true}'::jsonb;

COMMIT;
