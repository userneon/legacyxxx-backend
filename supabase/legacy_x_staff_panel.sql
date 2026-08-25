-- LEGACY-X staff panel: additive, audited server action queue and non-destructive product archival.
ALTER TABLE legacy_x.store_items ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS store_items_active_created_idx ON legacy_x.store_items (is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS legacy_x.staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('OWNER','MANAGER','ADMIN','DEVELOPER','DESIGNER')),
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_status_role_idx ON legacy_x.staff (status, role);
ALTER TABLE legacy_x.staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff TO service_role;

CREATE TABLE IF NOT EXISTS legacy_x.staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES legacy_x.staff(id) ON DELETE CASCADE,
  session_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS staff_sessions_active_idx ON legacy_x.staff_sessions (staff_id, expires_at) WHERE revoked_at IS NULL;
ALTER TABLE legacy_x.staff_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_sessions TO service_role;

CREATE TABLE IF NOT EXISTS legacy_x.staff_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES legacy_x.staff(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_audit_logs_staff_created_idx ON legacy_x.staff_audit_logs (staff_id, created_at DESC);
ALTER TABLE legacy_x.staff_audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_audit_logs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_audit_logs TO service_role;

CREATE TABLE IF NOT EXISTS legacy_x.staff_panel_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id text NOT NULL CHECK (server_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  requested_by uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  action_type text NOT NULL CHECK (action_type IN ('ban','unban','kick','mute','rename','map_change','server_announcement','match_announcement','hud_announcement','player_message','restart_all','restart_server','start_server','stop_server','timeout','round_restart','round_restore','player_ip_lookup')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed','failed','cancelled')),
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_panel_actions_server_status_created_idx ON legacy_x.staff_panel_actions (server_id, status, created_at);
CREATE INDEX IF NOT EXISTS staff_panel_actions_requester_created_idx ON legacy_x.staff_panel_actions (requested_by, created_at DESC);
ALTER TABLE legacy_x.staff_panel_actions ADD COLUMN IF NOT EXISTS requested_by_staff_id uuid REFERENCES legacy_x.staff(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS staff_panel_actions_staff_created_idx ON legacy_x.staff_panel_actions (requested_by_staff_id, created_at DESC);
ALTER TABLE legacy_x.staff_panel_actions DROP CONSTRAINT IF EXISTS staff_panel_actions_action_type_check;
ALTER TABLE legacy_x.staff_panel_actions ADD CONSTRAINT staff_panel_actions_action_type_check CHECK (action_type IN ('ban','unban','kick','mute','rename','map_change','server_announcement','match_announcement','hud_announcement','player_message','restart_all','restart_server','start_server','stop_server','timeout','round_restart','round_restore','player_ip_lookup'));
ALTER TABLE legacy_x.staff_panel_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_panel_actions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_panel_actions TO service_role;
