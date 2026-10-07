-- An Admin lifts their own penalties at will; lifting someone else's is a request that an Owner or Manager approves.
-- One open request per penalty. Only the API (service_role) reads or writes the table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.penalty_lift_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  penalty_id uuid NOT NULL REFERENCES legacy_x.penalties(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS penalty_lift_requests_pending_key ON legacy_x.penalty_lift_requests (penalty_id) WHERE status = 'pending';
ALTER TABLE legacy_x.penalty_lift_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.penalty_lift_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.penalty_lift_requests TO service_role;
