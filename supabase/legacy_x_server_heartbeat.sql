-- Game server heartbeat: every CS2 server (LegacyX-Status plugin) reports itself every 30 seconds
-- through POST /api/v1/plugin/servers/heartbeat. One transaction updates the server row the Play
-- pages, home tiles and Discord boards read (reconnect_servers) and the "who is on which server"
-- sessions profiles read (reconnect_sessions): players who left are closed, new ones are opened,
-- and a player seen here is closed on any other server.
--
-- Only the Root API (service_role) runs it. Safe to re-run.

BEGIN;

ALTER TABLE legacy_x.reconnect_servers ADD COLUMN IF NOT EXISTS max_players INTEGER;
ALTER TABLE legacy_x.reconnect_servers ADD COLUMN IF NOT EXISTS gotv_address TEXT;

CREATE OR REPLACE FUNCTION legacy_x.ingest_server_heartbeat(p_server jsonb, p_players jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path = legacy_x, pg_temp
AS $$
DECLARE
  v_server_id text := p_server->>'server_id';
  v_map text := NULLIF(p_server->>'map', '');
  v_mode text := NULLIF(p_server->>'mode', '');
  v_ids text[];
BEGIN
  IF v_server_id IS NULL OR v_server_id !~ '^[A-Za-z0-9._:-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid server id';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT p->>'steam_id'), '{}') INTO v_ids
  FROM jsonb_array_elements(p_players) p
  WHERE p->>'steam_id' ~ '^\d{15,20}$';

  INSERT INTO legacy_x.reconnect_servers (server_id, connect_address, display_name, current_map, current_mode, player_count, max_players, gotv_address, last_heartbeat_at, updated_at)
  VALUES (v_server_id, COALESCE(p_server->>'address', ''), NULLIF(p_server->>'name', ''), v_map, v_mode,
          cardinality(v_ids), (p_server->>'max_players')::int, NULLIF(p_server->>'gotv_address', ''), now(), now())
  ON CONFLICT (server_id) DO UPDATE SET
    connect_address = EXCLUDED.connect_address,
    display_name = EXCLUDED.display_name,
    current_map = EXCLUDED.current_map,
    current_mode = EXCLUDED.current_mode,
    player_count = EXCLUDED.player_count,
    max_players = EXCLUDED.max_players,
    gotv_address = EXCLUDED.gotv_address,
    last_heartbeat_at = now(),
    updated_at = now();

  -- Left this server, or now playing here after another one.
  UPDATE legacy_x.reconnect_sessions s
     SET disconnected_at = GREATEST(now(), s.connected_at),
         disconnect_reason = CASE WHEN s.server_id = v_server_id THEN 'left' ELSE 'moved' END,
         updated_at = now()
   WHERE s.disconnected_at IS NULL
     AND ((s.server_id = v_server_id AND NOT (s.steam_id = ANY (v_ids)))
       OR (s.server_id <> v_server_id AND s.steam_id = ANY (v_ids)));

  -- Still here: keep the name and map current.
  UPDATE legacy_x.reconnect_sessions s
     SET player_name = COALESCE(NULLIF(p->>'name', ''), s.player_name), map_name = v_map, mode = v_mode,
         reconnectable_until = now() + interval '5 minutes', updated_at = now()
    FROM jsonb_array_elements(p_players) p
   WHERE s.server_id = v_server_id AND s.disconnected_at IS NULL AND s.steam_id = p->>'steam_id';

  -- Joined.
  INSERT INTO legacy_x.reconnect_sessions (session_id, steam_id, player_name, server_id, map_name, mode, reconnectable_until)
  SELECT gen_random_uuid(), p->>'steam_id', left(COALESCE(p->>'name', ''), 128), v_server_id, v_map, v_mode, now() + interval '5 minutes'
    FROM (SELECT DISTINCT ON (p->>'steam_id') p FROM jsonb_array_elements(p_players) p WHERE p->>'steam_id' ~ '^\d{15,20}$') players
   WHERE NOT EXISTS (
     SELECT 1 FROM legacy_x.reconnect_sessions s
      WHERE s.server_id = v_server_id AND s.disconnected_at IS NULL AND s.steam_id = players.p->>'steam_id'
   );

  RETURN cardinality(v_ids);
END $$;

REVOKE EXECUTE ON FUNCTION legacy_x.ingest_server_heartbeat(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_server_heartbeat(jsonb, jsonb) TO service_role;

COMMIT;
