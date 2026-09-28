-- Discord ↔ Steam account links for the Discord bot's /link command and rank roles.
--
-- Flow: the bot (plugin token with discord:link) asks for a one-time link request; the player opens
-- the returned URL, signs in with Steam, and complete_discord_link() binds the Discord ID to their
-- legacy_x user. Only the SHA-256 of the request token is stored. One Discord account per user and
-- one user per Discord account; relinking replaces the old link.
--
-- Only the Root API (service_role) reads or writes these tables. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.discord_links (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  discord_id text NOT NULL UNIQUE CHECK (discord_id ~ '^[0-9]{17,20}$'),
  discord_name text NOT NULL DEFAULT '' CHECK (char_length(discord_name) <= 64),
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.discord_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  discord_id text NOT NULL CHECK (discord_id ~ '^[0-9]{17,20}$'),
  discord_name text NOT NULL DEFAULT '' CHECK (char_length(discord_name) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS discord_link_requests_expires_at_idx ON legacy_x.discord_link_requests (expires_at);

ALTER TABLE legacy_x.discord_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.discord_link_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.discord_links, legacy_x.discord_link_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.discord_links, legacy_x.discord_link_requests TO service_role;

-- Consumes a valid, unused, unexpired request and links its Discord ID to p_user_id in one
-- transaction. Returns the linked Discord ID, or NULL when the request is invalid, used or expired.
CREATE OR REPLACE FUNCTION legacy_x.complete_discord_link(p_token_hash text, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = legacy_x, pg_temp
AS $$
DECLARE
  request legacy_x.discord_link_requests;
BEGIN
  UPDATE legacy_x.discord_link_requests
     SET used_at = now()
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING * INTO request;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  DELETE FROM legacy_x.discord_links l WHERE l.discord_id = request.discord_id OR l.user_id = p_user_id;
  INSERT INTO legacy_x.discord_links (user_id, discord_id, discord_name)
  VALUES (p_user_id, request.discord_id, request.discord_name);
  -- Other pending links for this Discord account are now stale.
  DELETE FROM legacy_x.discord_link_requests r
   WHERE r.discord_id = request.discord_id AND r.id <> request.id AND r.used_at IS NULL;
  RETURN request.discord_id;
END $$;

REVOKE EXECUTE ON FUNCTION legacy_x.complete_discord_link(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.complete_discord_link(text, uuid) TO service_role;

COMMIT;
