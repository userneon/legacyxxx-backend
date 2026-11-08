-- Phone push notifications (iOS app, owner request 2026-11-08): the devices a player signed in on, and a mark on each bell
-- notification that says it was already pushed. Safe to re-run. Apply it before the API that sends pushes is deployed.

CREATE TABLE IF NOT EXISTS legacy_x.push_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (char_length(token) BETWEEN 32 AND 200),
  platform TEXT NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios')),
  -- "development" for a build run from Xcode, "production" for TestFlight and the App Store: Apple uses a different server for each.
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('development', 'production')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON legacy_x.push_devices (user_id);
ALTER TABLE legacy_x.push_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.push_devices FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.push_devices TO service_role;

-- Everything that exists now counts as pushed, so turning this on never sends the old feed to anyone.
ALTER TABLE legacy_x.notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMPTZ;
UPDATE legacy_x.notifications SET pushed_at = now() WHERE pushed_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_unpushed_idx ON legacy_x.notifications (created_at) WHERE pushed_at IS NULL;
