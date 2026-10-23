-- Site settings (owner request 2026-10-23): numbers staff can change from the staff site (Staff → Settings, Owner only) instead of the code.
-- A row only exists once a value was changed; without one the API uses the default written in server/legacyX/settings.ts.
-- Only the Root API (service_role) reads or writes this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.site_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9._-]{3,64}$'),
  value numeric NOT NULL,
  updated_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.site_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.site_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.site_settings TO service_role;
NOTIFY pgrst, 'reload schema';
