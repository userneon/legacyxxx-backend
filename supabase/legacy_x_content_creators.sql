-- Content creators (owner request 2026-10-12): two tiers, Main Content Creator and Content Creator, shown as a badge on the
-- player's profile and on the website's Creators page. Kept apart from legacy_x.staff on purpose: a creator gets no staff
-- permission of any kind. Owners and Managers add and edit them from the Staff page (/staffpanel/creators).
-- Additive and safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.content_creators (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('main', 'creator')),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 200),
  links jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(links) = 'object'),
  sort smallint NOT NULL DEFAULT 0,
  added_by uuid NULL REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only the API (service role) reads and writes it.
ALTER TABLE legacy_x.content_creators ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.content_creators FROM anon, authenticated;
