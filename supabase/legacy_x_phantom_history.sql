-- Standalone LegacyX Phantom History. No PlayerTelemetry tables or player identity data are reused.
-- Apply only through the restored controlled Supabase MCP migration path.
CREATE TABLE IF NOT EXISTS legacy_x.phantom_history_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id TEXT NOT NULL CHECK (plugin_id = 'legacyx-phantom'),
  source_ref UUID NOT NULL,
  match_reference TEXT NOT NULL CHECK (char_length(match_reference) <= 255),
  server_id TEXT NOT NULL CHECK (char_length(server_id) <= 120),
  server_mode TEXT NOT NULL CHECK (char_length(server_mode) <= 64),
  map_name TEXT NOT NULL CHECK (char_length(map_name) <= 128),
  round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 500),
  sample_count INTEGER NOT NULL CHECK (sample_count BETWEEN 3 AND 600),
  samples JSONB NOT NULL CHECK (jsonb_typeof(samples) = 'array' AND jsonb_array_length(samples) BETWEEN 3 AND 600),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, match_reference, round_number, source_ref)
);

CREATE INDEX IF NOT EXISTS phantom_history_replay_idx ON legacy_x.phantom_history_rounds (server_id, map_name, completed_at DESC) WHERE sample_count >= 12;

ALTER TABLE legacy_x.phantom_history_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE legacy_x.phantom_history_rounds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE legacy_x.phantom_history_rounds TO service_role;
