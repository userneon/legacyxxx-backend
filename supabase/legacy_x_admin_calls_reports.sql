-- !report joins !calladmin / !callmanager in legacy_x.admin_calls, so the Discord bot announces both in one feed.
-- A report is a row with target = 'report' plus who was reported and why.
BEGIN;

ALTER TABLE legacy_x.admin_calls DROP CONSTRAINT IF EXISTS admin_calls_target_check;
ALTER TABLE legacy_x.admin_calls ADD CONSTRAINT admin_calls_target_check CHECK (target IN ('admin', 'manager', 'report'));

ALTER TABLE legacy_x.admin_calls
  ADD COLUMN IF NOT EXISTS reported_steam_id TEXT CHECK (reported_steam_id IS NULL OR reported_steam_id ~ '^7656119[0-9]{10}$'),
  ADD COLUMN IF NOT EXISTS reported_name TEXT CHECK (reported_name IS NULL OR char_length(reported_name) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 300);

COMMIT;
