BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.adminplus_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL DEFAULT 'adminplus',
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'server',
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS adminplus_audit_logs_created_at_idx
  ON legacy_x.adminplus_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS adminplus_audit_logs_action_idx
  ON legacy_x.adminplus_audit_logs (action);

ALTER TABLE legacy_x.adminplus_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON legacy_x.adminplus_audit_logs FROM anon, authenticated;
GRANT USAGE ON SCHEMA legacy_x TO service_role;
GRANT INSERT, SELECT ON legacy_x.adminplus_audit_logs TO service_role;

COMMIT;
