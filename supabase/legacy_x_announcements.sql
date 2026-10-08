-- Update announcements for Discord. The deploy scripts (website, API, bot, game servers) post one row per update
-- (POST /plugin/announcements); the Discord bot polls GET /plugin/announcements and posts new rows in the
-- channel chosen with /updates. (Not the website's `announcements` table from legacy_x_admin_system.sql: that one has uuid ids and other columns.)
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.update_announcements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 30),
  footer TEXT CHECK (footer IS NULL OR char_length(footer) <= 200),
  banner TEXT CHECK (banner IS NULL OR banner IN ('cs2-update-finished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS update_announcements_created_idx ON legacy_x.update_announcements (created_at DESC);

-- Same as every other table: browsers never read it, only the Root API (service_role) does.
REVOKE ALL ON TABLE legacy_x.update_announcements FROM anon, authenticated;
ALTER TABLE legacy_x.update_announcements ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON TABLE legacy_x.update_announcements TO service_role;

COMMIT;
