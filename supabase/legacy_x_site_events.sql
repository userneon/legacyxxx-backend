-- Holiday looks (owner request 2026-11-08): the events the website, the iOS app and the Discord bot dress up for. Safe to re-run.
-- Staff → Settings → Events (Owner) adds them; GET /public/events/active says which one runs today (Ulaanbaatar days).

CREATE TABLE IF NOT EXISTS legacy_x.site_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theme TEXT NOT NULL CHECK (theme IN ('halloween', 'new-year', 'tsagaan-sar')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT site_events_days_check CHECK (ends_on >= starts_on AND ends_on - starts_on <= 62)
);
CREATE INDEX IF NOT EXISTS site_events_days_idx ON legacy_x.site_events (starts_on, ends_on);
ALTER TABLE legacy_x.site_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.site_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.site_events TO service_role;
