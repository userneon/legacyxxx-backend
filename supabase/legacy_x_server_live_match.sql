BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.server_live_match_snapshots (
  server_id TEXT PRIMARY KEY REFERENCES legacy_x.reconnect_servers(server_id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'live', 'paused', 'ended')),
  map_name TEXT NOT NULL DEFAULT '',
  round_number INTEGER CHECK (round_number IS NULL OR round_number >= 0),
  score_t INTEGER CHECK (score_t IS NULL OR score_t >= 0),
  score_ct INTEGER CHECK (score_ct IS NULL OR score_ct >= 0),
  terrorist_players JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(terrorist_players) = 'array'),
  counter_terrorist_players JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(counter_terrorist_players) = 'array'),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS server_live_match_snapshots_reported_at_idx
  ON legacy_x.server_live_match_snapshots (reported_at DESC);

ALTER TABLE legacy_x.server_live_match_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.server_live_match_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.server_live_match_snapshots TO service_role;

COMMIT;
