BEGIN;

-- Additive v1 live snapshot contract. Existing snapshots remain readable and
-- are treated as legacy revision 0 until a plugin sends a v1 update.
ALTER TABLE legacy_x.server_live_match_snapshots
  ADD COLUMN IF NOT EXISTS schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  ADD COLUMN IF NOT EXISTS snapshot_revision INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_revision >= 0),
  ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS spectator_players JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(spectator_players) = 'array'),
  ADD COLUMN IF NOT EXISTS source_plugin_id TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS server_live_match_snapshots_revision_idx
  ON legacy_x.server_live_match_snapshots (server_id, snapshot_revision DESC);

CREATE TABLE IF NOT EXISTS legacy_x.server_live_match_snapshot_receipts (
  event_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES legacy_x.reconnect_servers(server_id) ON DELETE RESTRICT,
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision >= 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS server_live_match_snapshot_receipts_server_idx
  ON legacy_x.server_live_match_snapshot_receipts (server_id, received_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.ingest_server_live_match_snapshot(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_server_id TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_inserted BOOLEAN;
  v_existing_revision INTEGER;
  v_revision INTEGER := COALESCE((p_payload->>'snapshot_revision')::INTEGER, -1);
  v_schema_version INTEGER := COALESCE((p_payload->>'schema_version')::INTEGER, -1);
  v_captured_at TIMESTAMPTZ;
BEGIN
  IF p_plugin_id NOT IN ('legacyx-reconnect', 'legacyx-live-snapshot') THEN
    RAISE EXCEPTION 'Unsupported live snapshot plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF v_schema_version <> 1 OR v_revision < 0 THEN
    RAISE EXCEPTION 'Unsupported live snapshot contract' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_captured_at := (p_payload->>'captured_at')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Invalid captured_at' USING ERRCODE = '22023';
  END;
  IF v_captured_at > now() + interval '60 seconds' OR v_captured_at < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'Live snapshot captured_at is outside the accepted window' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM legacy_x.reconnect_servers WHERE server_id = p_server_id) THEN
    RAISE EXCEPTION 'Live snapshot requires a prior server heartbeat' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.server_live_match_snapshot_receipts (event_id, plugin_id, server_id, snapshot_revision)
  VALUES (p_event_id, p_plugin_id, p_server_id, v_revision)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO v_inserted;
  IF NOT COALESCE(v_inserted, false) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'server_id', p_server_id, 'snapshot_revision', v_revision);
  END IF;

  SELECT snapshot_revision INTO v_existing_revision
  FROM legacy_x.server_live_match_snapshots
  WHERE server_id = p_server_id
  FOR UPDATE;
  IF FOUND AND v_revision <= v_existing_revision THEN
    RETURN jsonb_build_object('status', 'stale', 'server_id', p_server_id, 'snapshot_revision', v_revision, 'current_revision', v_existing_revision);
  END IF;

  INSERT INTO legacy_x.server_live_match_snapshots (
    server_id, source_event_id, source_plugin_id, schema_version, snapshot_revision,
    state, map_name, round_number, score_t, score_ct, terrorist_players,
    counter_terrorist_players, spectator_players, captured_at, reported_at, updated_at
  ) VALUES (
    p_server_id, p_event_id, p_plugin_id, v_schema_version, v_revision,
    p_payload->>'state', COALESCE(p_payload->>'map_name', ''),
    NULLIF(p_payload->>'round_number', '')::INTEGER, NULLIF(p_payload->>'score_t', '')::INTEGER,
    NULLIF(p_payload->>'score_ct', '')::INTEGER, COALESCE(p_payload->'terrorist_players', '[]'::JSONB),
    COALESCE(p_payload->'counter_terrorist_players', '[]'::JSONB), COALESCE(p_payload->'spectator_players', '[]'::JSONB),
    v_captured_at, now(), now()
  ) ON CONFLICT (server_id) DO UPDATE SET
    source_event_id = EXCLUDED.source_event_id,
    source_plugin_id = EXCLUDED.source_plugin_id,
    schema_version = EXCLUDED.schema_version,
    snapshot_revision = EXCLUDED.snapshot_revision,
    state = EXCLUDED.state,
    map_name = EXCLUDED.map_name,
    round_number = EXCLUDED.round_number,
    score_t = EXCLUDED.score_t,
    score_ct = EXCLUDED.score_ct,
    terrorist_players = EXCLUDED.terrorist_players,
    counter_terrorist_players = EXCLUDED.counter_terrorist_players,
    spectator_players = EXCLUDED.spectator_players,
    captured_at = EXCLUDED.captured_at,
    reported_at = EXCLUDED.reported_at,
    updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object('status', 'processed', 'server_id', p_server_id, 'snapshot_revision', v_revision, 'captured_at', v_captured_at);
END;
$$;

ALTER TABLE legacy_x.server_live_match_snapshot_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.server_live_match_snapshot_receipts FROM anon, authenticated;
GRANT SELECT, INSERT ON legacy_x.server_live_match_snapshot_receipts TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_server_live_match_snapshot(TEXT, TEXT, TEXT, JSONB) TO service_role;

COMMIT;
