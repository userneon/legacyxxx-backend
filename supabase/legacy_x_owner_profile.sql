-- Owner profile: Respect given by players, and the Owner's own links and message.
-- Team and updates on that page come from the existing staff and announcements tables, so they need nothing new.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.profile_respect (
  target_user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  giver_user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_user_id, giver_user_id),
  CHECK (target_user_id <> giver_user_id)
);

CREATE TABLE IF NOT EXISTS legacy_x.owner_profile (
  user_id UUID PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  links JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 8),
  message TEXT CHECK (message IS NULL OR char_length(message) <= 280),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same as every other table: browsers never read them, only the Root API (service_role) does.
REVOKE ALL ON TABLE legacy_x.profile_respect, legacy_x.owner_profile FROM anon, authenticated;
ALTER TABLE legacy_x.profile_respect ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.owner_profile ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON TABLE legacy_x.profile_respect TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE legacy_x.owner_profile TO service_role;

COMMIT;
