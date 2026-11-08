-- Account deletion requests (owner request 2026-11-08; the App Store requires an in-app way to ask). A request is kept, never executed
-- by the API: a ban or a penalty must not be wiped by deleting the account, so a person on staff looks at each one.
-- Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  steam_id TEXT,
  username TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500)
);
ALTER TABLE legacy_x.account_deletion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.account_deletion_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.account_deletion_requests TO service_role;
