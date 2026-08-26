-- Additive, idempotent player performance and disconnect telemetry contract.
-- Run only after Supabase MCP OAuth is restored; do not apply from browser code.

CREATE TABLE IF NOT EXISTS legacy_x.player_telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('round_snapshot', 'player_disconnected')),
  server_id text NOT NULL,
  server_mode text NOT NULL DEFAULT '',
  match_reference text NOT NULL,
  map_name text NOT NULL DEFAULT '',
  steam_id text NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  player_name text NOT NULL DEFAULT '',
  round_number integer NOT NULL DEFAULT 0 CHECK (round_number >= 0),
  match_state text NOT NULL DEFAULT 'live' CHECK (match_state IN ('waiting', 'live', 'paused', 'ended')),
  active_seconds integer NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
  disconnect_method text NULL CHECK (disconnect_method IN ('client_disconnect', 'admin_kick', 'admin_ban', 'server_shutdown', 'unknown')),
  disconnect_reason text NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, event_id)
);

CREATE INDEX IF NOT EXISTS player_telemetry_events_player_match_idx
  ON legacy_x.player_telemetry_events (steam_id, match_reference, occurred_at DESC);
CREATE INDEX IF NOT EXISTS player_telemetry_events_disconnect_idx
  ON legacy_x.player_telemetry_events (event_type, occurred_at DESC)
  WHERE event_type = 'player_disconnected';

ALTER TABLE legacy_x.player_telemetry_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE legacy_x.player_telemetry_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE legacy_x.player_telemetry_events TO service_role;

CREATE OR REPLACE FUNCTION legacy_x.ingest_player_telemetry_event(
  p_plugin_id text,
  p_event_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  inserted_id uuid;
BEGIN
  INSERT INTO legacy_x.player_telemetry_events (
    plugin_id, event_id, event_type, server_id, server_mode, match_reference, map_name,
    steam_id, player_name, round_number, match_state, active_seconds,
    disconnect_method, disconnect_reason, metrics
  ) VALUES (
    p_plugin_id, p_event_id, p_payload->>'event_type', p_payload->>'server_id',
    COALESCE(p_payload->>'server_mode', ''), p_payload->>'match_reference',
    COALESCE(p_payload->>'map_name', ''), p_payload->>'steam_id',
    COALESCE(p_payload->>'player_name', ''), COALESCE((p_payload->>'round_number')::integer, 0),
    COALESCE(p_payload->>'match_state', 'live'), COALESCE((p_payload->>'active_seconds')::integer, 0),
    NULLIF(p_payload->>'disconnect_method', ''), NULLIF(p_payload->>'disconnect_reason', ''),
    COALESCE(p_payload->'metrics', '{}'::jsonb)
  )
  ON CONFLICT (plugin_id, event_id) DO NOTHING
  RETURNING id INTO inserted_id;

  RETURN jsonb_build_object('status', CASE WHEN inserted_id IS NULL THEN 'duplicate' ELSE 'accepted' END, 'id', inserted_id);
END;
$$;

REVOKE ALL ON FUNCTION legacy_x.ingest_player_telemetry_event(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_player_telemetry_event(text, text, jsonb) TO service_role;

CREATE OR REPLACE VIEW legacy_x.player_telemetry_match_latest AS
SELECT DISTINCT ON (steam_id, match_reference)
  steam_id, player_name, match_reference, server_id, server_mode, map_name,
  round_number, active_seconds, metrics, event_type, disconnect_method,
  disconnect_reason, occurred_at
FROM legacy_x.player_telemetry_events
ORDER BY steam_id, match_reference, occurred_at DESC;

CREATE OR REPLACE VIEW legacy_x.player_telemetry_profile_summary AS
SELECT
  steam_id,
  max(player_name) AS player_name,
  count(*) AS observed_matches,
  round(avg(active_seconds))::integer AS average_active_seconds_per_match,
  round(avg(round_number), 2) AS average_round_reached,
  count(*) FILTER (WHERE event_type = 'player_disconnected') AS disconnect_count,
  round(avg(round_number) FILTER (WHERE event_type = 'player_disconnected'), 2) AS average_disconnect_round,
  sum(COALESCE((metrics->>'kills')::integer, 0)) AS total_kills,
  sum(COALESCE((metrics->>'deaths')::integer, 0)) AS total_deaths,
  sum(COALESCE((metrics->>'damage_dealt')::integer, 0)) AS total_damage_dealt,
  sum(COALESCE((metrics->>'damage_taken')::integer, 0)) AS total_damage_taken,
  CASE
    WHEN sum(COALESCE((metrics->>'deaths')::integer, 0)) = 0 THEN NULL
    ELSE round(sum(COALESCE((metrics->>'kills')::numeric, 0)) / sum(COALESCE((metrics->>'deaths')::numeric, 0)), 2)
  END AS kill_death_ratio,
  CASE
    WHEN sum(COALESCE((metrics->>'damage_taken')::integer, 0)) = 0 THEN NULL
    ELSE round(sum(COALESCE((metrics->>'damage_dealt')::numeric, 0)) / sum(COALESCE((metrics->>'damage_taken')::numeric, 0)), 2)
  END AS damage_exchange_ratio
FROM legacy_x.player_telemetry_match_latest
GROUP BY steam_id;

REVOKE ALL ON legacy_x.player_telemetry_match_latest, legacy_x.player_telemetry_profile_summary FROM anon, authenticated;
GRANT SELECT ON legacy_x.player_telemetry_match_latest, legacy_x.player_telemetry_profile_summary TO service_role;
