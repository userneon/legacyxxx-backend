-- In-game staff authorization for LegacyX-Admin.
--
-- The CS2 plugin no longer keeps a local admins.json; it asks the Root API about each connected
-- player (POST /api/v1/plugin/admin/authorizations) and grants CounterStrikeSharp permissions from
-- the answer. This file adds per-server staff assignments and the function that resolves a
-- player's in-game role for one server.
--
-- Resolution for (steam_id, server_id), first match wins:
--   1. A staff_server_assignments row for that exact server. It decides for that server: the role
--      applies only while status = 'active' and expires_at is unset or in the future; otherwise the
--      player has no in-game authority there (even if they hold a global staff role).
--   2. The global legacy_x.staff row of the user with that SteamID. Global staff already applied to
--      every server (GET /plugin/admin-policy); that stays the case. OWNER/MANAGER/ADMIN map to
--      owner/manager/admin while status = 'active'. DEVELOPER/DESIGNER are website roles and get no
--      in-game authority.
--   3. Otherwise: player (no authority).
--
-- Additive and safe to re-run. Existing tables and data are untouched.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.staff_server_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id text NOT NULL CHECK (steam_id ~ '^7656119[0-9]{10}$'),
  -- The LEGACYX_SERVER_ID configured on the game server.
  server_id text NOT NULL CHECK (server_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'admin', 'staff')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  expires_at timestamptz,
  granted_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (steam_id, server_id)
);

CREATE INDEX IF NOT EXISTS staff_server_assignments_server_idx ON legacy_x.staff_server_assignments (server_id);

-- Only the Root API (service role) reads or writes assignments.
ALTER TABLE legacy_x.staff_server_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_server_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_server_assignments TO service_role;

CREATE OR REPLACE FUNCTION legacy_x.resolve_game_staff(p_server_id text, p_steam_ids text[])
RETURNS TABLE (steam_id text, role text, status text, source text, expires_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = legacy_x, pg_temp
AS $$
  WITH ids AS (
    SELECT DISTINCT requested AS steam_id FROM unnest(p_steam_ids) AS requested
  ),
  server_row AS (
    SELECT a.steam_id, a.role, a.status, a.expires_at
    FROM legacy_x.staff_server_assignments a
    WHERE a.server_id = p_server_id AND a.steam_id = ANY (p_steam_ids)
  ),
  global_row AS (
    SELECT u.steam_id, s.role AS staff_role, s.status
    FROM legacy_x.staff s
    JOIN legacy_x.users u ON u.id = s.user_id
    WHERE u.steam_id = ANY (p_steam_ids)
  )
  SELECT
    ids.steam_id,
    CASE
      WHEN sr.steam_id IS NOT NULL THEN
        CASE WHEN sr.status = 'active' AND (sr.expires_at IS NULL OR sr.expires_at > now()) THEN sr.role ELSE 'player' END
      WHEN gr.steam_id IS NOT NULL AND gr.status = 'active' THEN
        CASE gr.staff_role WHEN 'OWNER' THEN 'owner' WHEN 'MANAGER' THEN 'manager' WHEN 'ADMIN' THEN 'admin' ELSE 'player' END
      ELSE 'player'
    END,
    CASE
      WHEN sr.steam_id IS NOT NULL THEN
        CASE
          WHEN sr.status <> 'active' THEN sr.status
          WHEN sr.expires_at IS NOT NULL AND sr.expires_at <= now() THEN 'expired'
          ELSE 'active'
        END
      WHEN gr.steam_id IS NOT NULL THEN gr.status
      ELSE 'none'
    END,
    CASE WHEN sr.steam_id IS NOT NULL THEN 'server' WHEN gr.steam_id IS NOT NULL THEN 'global' ELSE 'none' END,
    sr.expires_at
  FROM ids
  LEFT JOIN server_row sr ON sr.steam_id = ids.steam_id
  LEFT JOIN global_row gr ON gr.steam_id = ids.steam_id;
$$;

REVOKE ALL ON FUNCTION legacy_x.resolve_game_staff(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.resolve_game_staff(text, text[]) TO service_role;

COMMIT;

-- Verification:
-- SELECT * FROM legacy_x.resolve_game_staff('some-server', ARRAY['76561190000000001']);
--   → one row: role 'player', status 'none', source 'none'.
