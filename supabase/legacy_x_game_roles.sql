-- In-game roles you can shape on the staff site (owner request 2026-11-02). One row per editable role (creator, main_creator, staff, admin,
-- manager): its commands, extra permissions, the kinds of server it works on and its immunity, as JSON the API checks (gameRoles.ts) before
-- it is saved and again when it is read. No row means the built-in role. The Owner role is not here: it is built into the plugin. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.game_roles (
  role text PRIMARY KEY CHECK (role IN ('creator', 'main_creator', 'staff', 'admin', 'manager')),
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES legacy_x.users (id) ON DELETE SET NULL
);
ALTER TABLE legacy_x.game_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.game_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.game_roles TO service_role;
