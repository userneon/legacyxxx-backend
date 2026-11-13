-- Player reports from the website (owner request 2026-11-13, "start from the website"): a signed-in player reports another player with a category, a
-- short reason and an optional https evidence link; staff (Admin and above) read the queue on the staff site and answer "Action taken" or "No action";
-- the reporter is told the outcome in the bell. In-game !report/!calladmin stay in legacy_x.admin_calls. Only the API (service_role) uses the table.
-- One open report per reporter and player. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.player_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  reported_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('cheating', 'griefing', 'toxic', 'boosting', 'other')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 300),
  evidence_url text CHECK (evidence_url IS NULL OR (evidence_url ~ '^https://' AND char_length(evidence_url) <= 300)),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  handled_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  handled_at timestamptz,
  staff_note text CHECK (staff_note IS NULL OR char_length(staff_note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reporter_id <> reported_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS player_reports_open_key ON legacy_x.player_reports (reporter_id, reported_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS player_reports_status_idx ON legacy_x.player_reports (status, created_at);
CREATE INDEX IF NOT EXISTS player_reports_reported_idx ON legacy_x.player_reports (reported_id);
ALTER TABLE legacy_x.player_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.player_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.player_reports TO service_role;
