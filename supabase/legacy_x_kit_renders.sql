-- Animated Creator kit (owner request 2026-11-07): a creator types a name (and a code) on the website and the API renders the animations (Remotion) with them.
-- One row per request; the files live on the API server for a day and are removed with the row. Safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.kit_renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'done', 'failed')),
  name text NOT NULL DEFAULT '',
  code text NOT NULL DEFAULT '',
  items text[] NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS kit_renders_user_idx ON legacy_x.kit_renders (user_id, created_at DESC);
ALTER TABLE legacy_x.kit_renders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.kit_renders TO service_role;

COMMIT;
