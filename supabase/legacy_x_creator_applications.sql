-- Creator applications (owner request 2026-10-23): a player asks to become a content creator from the Creators page (a short line about their content and
-- at least one channel link); an Owner or Manager approves (choosing Content Creator or Main Content Creator) or declines from Staff → Creators.
-- Approving creates the legacy_x.content_creators row. Only the Root API (service_role) reads or writes this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.creator_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  bio text NOT NULL CHECK (char_length(bio) BETWEEN 10 AND 200),
  links jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(links) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  decided_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One open application per player.
CREATE UNIQUE INDEX IF NOT EXISTS creator_applications_one_pending ON legacy_x.creator_applications (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS creator_applications_status_idx ON legacy_x.creator_applications (status, created_at);
ALTER TABLE legacy_x.creator_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.creator_applications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.creator_applications TO service_role;
NOTIFY pgrst, 'reload schema';
