-- Reactions on reviews: like, love or funny, one per player per review. Only the API (service_role) touches the table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.feedback_reactions (
  feedback_id uuid NOT NULL REFERENCES legacy_x.feedback(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (reaction IN ('like', 'love', 'funny')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feedback_id, user_id)
);
CREATE INDEX IF NOT EXISTS feedback_reactions_feedback_idx ON legacy_x.feedback_reactions (feedback_id);
ALTER TABLE legacy_x.feedback_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.feedback_reactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.feedback_reactions TO service_role;
