BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.reconnect_event_receipts (
  event_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('player_connected', 'player_disconnected', 'server_heartbeat')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.reconnect_servers (
  server_id TEXT PRIMARY KEY,
  connect_address TEXT NOT NULL,
  display_name TEXT,
  current_map TEXT,
  current_mode TEXT,
  player_count INTEGER NOT NULL DEFAULT 0 CHECK (player_count >= 0),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.reconnect_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE,
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  player_name TEXT NOT NULL DEFAULT '',
  server_id TEXT NOT NULL REFERENCES legacy_x.reconnect_servers(server_id) ON DELETE RESTRICT,
  map_name TEXT,
  mode TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  disconnect_reason TEXT,
  reconnectable_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
);

CREATE INDEX IF NOT EXISTS reconnect_sessions_player_recent_idx ON legacy_x.reconnect_sessions (steam_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS reconnect_sessions_active_idx ON legacy_x.reconnect_sessions (server_id, reconnectable_until DESC);

CREATE OR REPLACE VIEW legacy_x.reconnect_last_played AS
SELECT
  rs.session_id,
  rs.steam_id,
  rs.player_name,
  rs.server_id,
  srv.connect_address,
  COALESCE(srv.display_name, rs.server_id) AS server_name,
  COALESCE(rs.map_name, srv.current_map) AS map_name,
  COALESCE(rs.mode, srv.current_mode) AS mode,
  rs.connected_at,
  rs.disconnected_at,
  rs.disconnect_reason,
  rs.reconnectable_until,
  srv.player_count,
  srv.last_heartbeat_at,
  srv.last_heartbeat_at >= now() - interval '90 seconds' AS server_online
FROM legacy_x.reconnect_sessions rs
JOIN legacy_x.reconnect_servers srv ON srv.server_id = rs.server_id;

CREATE OR REPLACE FUNCTION legacy_x.ingest_reconnect_event(
  p_event_id TEXT,
  p_plugin_id TEXT,
  p_event_type TEXT,
  p_session_id UUID,
  p_steam_id TEXT,
  p_player_name TEXT,
  p_server_id TEXT,
  p_server_address TEXT,
  p_map_name TEXT,
  p_mode TEXT,
  p_disconnect_reason TEXT DEFAULT NULL,
  p_reconnect_window_minutes INTEGER DEFAULT 720
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_inserted BOOLEAN;
BEGIN
  IF p_event_type NOT IN ('player_connected', 'player_disconnected') THEN
    RAISE EXCEPTION 'Unsupported reconnect event type' USING ERRCODE = '22023';
  END IF;
  IF p_reconnect_window_minutes < 5 OR p_reconnect_window_minutes > 1440 THEN
    RAISE EXCEPTION 'Reconnect window must be between 5 and 1440 minutes' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.reconnect_event_receipts (event_id, plugin_id, event_type)
  VALUES (p_event_id, p_plugin_id, p_event_type)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO v_inserted;
  IF NOT COALESCE(v_inserted, false) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  INSERT INTO legacy_x.reconnect_servers (server_id, connect_address, current_map, current_mode)
  VALUES (p_server_id, p_server_address, NULLIF(p_map_name, ''), NULLIF(p_mode, ''))
  ON CONFLICT (server_id) DO UPDATE SET
    connect_address = EXCLUDED.connect_address,
    current_map = COALESCE(EXCLUDED.current_map, legacy_x.reconnect_servers.current_map),
    current_mode = COALESCE(EXCLUDED.current_mode, legacy_x.reconnect_servers.current_mode),
    last_heartbeat_at = now(),
    updated_at = now();

  IF p_event_type = 'player_connected' THEN
    INSERT INTO legacy_x.reconnect_sessions (
      session_id, steam_id, player_name, server_id, map_name, mode, reconnectable_until
    ) VALUES (
      p_session_id, p_steam_id, left(COALESCE(p_player_name, ''), 128), p_server_id,
      NULLIF(p_map_name, ''), NULLIF(p_mode, ''), now() + make_interval(mins => p_reconnect_window_minutes)
    ) ON CONFLICT (session_id) DO UPDATE SET
      player_name = EXCLUDED.player_name,
      map_name = COALESCE(EXCLUDED.map_name, legacy_x.reconnect_sessions.map_name),
      mode = COALESCE(EXCLUDED.mode, legacy_x.reconnect_sessions.mode),
      updated_at = now();
  ELSE
    UPDATE legacy_x.reconnect_sessions
    SET disconnected_at = COALESCE(disconnected_at, now()),
        disconnect_reason = left(COALESCE(p_disconnect_reason, ''), 96),
        map_name = COALESCE(NULLIF(p_map_name, ''), map_name),
        mode = COALESCE(NULLIF(p_mode, ''), mode),
        updated_at = now()
    WHERE session_id = p_session_id AND steam_id = p_steam_id AND server_id = p_server_id;
  END IF;

  RETURN jsonb_build_object('status', 'accepted', 'event', p_event_type, 'session_id', p_session_id);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_reconnect_heartbeat(
  p_event_id TEXT,
  p_plugin_id TEXT,
  p_server_id TEXT,
  p_server_address TEXT,
  p_map_name TEXT,
  p_mode TEXT,
  p_player_count INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_inserted BOOLEAN;
BEGIN
  IF p_player_count < 0 OR p_player_count > 128 THEN
    RAISE EXCEPTION 'Invalid player count' USING ERRCODE = '22023';
  END IF;
  INSERT INTO legacy_x.reconnect_event_receipts (event_id, plugin_id, event_type)
  VALUES (p_event_id, p_plugin_id, 'server_heartbeat')
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO v_inserted;
  IF NOT COALESCE(v_inserted, false) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  INSERT INTO legacy_x.reconnect_servers (server_id, connect_address, current_map, current_mode, player_count)
  VALUES (p_server_id, p_server_address, NULLIF(p_map_name, ''), NULLIF(p_mode, ''), p_player_count)
  ON CONFLICT (server_id) DO UPDATE SET
    connect_address = EXCLUDED.connect_address,
    current_map = EXCLUDED.current_map,
    current_mode = EXCLUDED.current_mode,
    player_count = EXCLUDED.player_count,
    last_heartbeat_at = now(),
    updated_at = now();
  RETURN jsonb_build_object('status', 'accepted', 'server_id', p_server_id);
END;
$$;

ALTER TABLE legacy_x.reconnect_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.reconnect_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.reconnect_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.reconnect_event_receipts, legacy_x.reconnect_servers, legacy_x.reconnect_sessions, legacy_x.reconnect_last_played FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.reconnect_event_receipts, legacy_x.reconnect_servers, legacy_x.reconnect_sessions, legacy_x.reconnect_last_played TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_reconnect_event(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_reconnect_heartbeat(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

COMMIT;
