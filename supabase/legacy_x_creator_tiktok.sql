-- Content creators prove their TikTok account with TikTok Login Kit (OAuth2): a creator presses "Connect TikTok" on the website, TikTok
-- shows its own consent page and tells the API who the account is. Only the account's public profile is kept (no access token is stored);
-- a creator may link one account, and one TikTok account belongs to one creator. Both tables are used by the API (service_role) only.
-- Safe to re-run. Run it once, then set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI on the API.
CREATE TABLE IF NOT EXISTS legacy_x.tiktok_oauth_states (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.tiktok_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.tiktok_oauth_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.tiktok_oauth_states TO service_role;

CREATE TABLE IF NOT EXISTS legacy_x.creator_tiktok (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  open_id text NOT NULL UNIQUE,
  username text NOT NULL DEFAULT '' CHECK (char_length(username) <= 64),
  display_name text NOT NULL DEFAULT '' CHECK (char_length(display_name) <= 100),
  avatar_url text NULL CHECK (avatar_url IS NULL OR avatar_url ~ '^https://'),
  follower_count bigint NULL CHECK (follower_count IS NULL OR follower_count >= 0),
  likes_count bigint NULL CHECK (likes_count IS NULL OR likes_count >= 0),
  video_count bigint NULL CHECK (video_count IS NULL OR video_count >= 0),
  linked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.creator_tiktok ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.creator_tiktok FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.creator_tiktok TO service_role;
