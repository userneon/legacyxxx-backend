-- In-game !calladmin / !callmanager requests, for the Discord bot to announce.
-- LegacyX-Admin posts one row per request (POST /plugin/admin-calls); the Discord bot polls
-- GET /plugin/admin-calls and posts new rows in the channel chosen with /admincalls.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.admin_calls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  caller_steam_id TEXT NOT NULL CHECK (caller_steam_id ~ '^7656119[0-9]{10}$'),
  caller_name TEXT NOT NULL CHECK (char_length(caller_name) BETWEEN 1 AND 64),
  target TEXT NOT NULL CHECK (target IN ('admin', 'manager')),
  server_id TEXT NOT NULL CHECK (char_length(server_id) BETWEEN 1 AND 64),
  server_name TEXT CHECK (server_name IS NULL OR char_length(server_name) <= 96),
  map TEXT CHECK (map IS NULL OR char_length(map) <= 64),
  players SMALLINT CHECK (players IS NULL OR players BETWEEN 0 AND 128),
  online_staff SMALLINT NOT NULL CHECK (online_staff BETWEEN 0 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_calls_created_idx ON legacy_x.admin_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_calls_caller_idx ON legacy_x.admin_calls (caller_steam_id, created_at DESC);

-- Same as every other table: browsers never read it, only the Root API (service_role) does.
REVOKE ALL ON TABLE legacy_x.admin_calls FROM anon, authenticated;
ALTER TABLE legacy_x.admin_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON TABLE legacy_x.admin_calls TO service_role;

COMMIT;
