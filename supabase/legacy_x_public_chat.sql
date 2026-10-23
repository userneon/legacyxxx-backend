-- Public chat (owner request 2026-10-23): one community chat on the website, bottom right. Signed-in players write, everyone reads.
-- Staff can remove a message (deleted_at). A player with an active gag cannot write. Old messages are removed by the API.
-- Only the Root API (service_role) reads or writes this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_recent_idx ON legacy_x.chat_messages (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON legacy_x.chat_messages (user_id, created_at DESC);
ALTER TABLE legacy_x.chat_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.chat_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.chat_messages TO service_role;
NOTIFY pgrst, 'reload schema';
