-- The Market (owner request 2026-11-07): players post what they like to sell, with a title, a description, photos, an optional price, phone and email.
-- Contact details are shown only to signed-in players. A listing lasts 45 days; three reports hide it until staff look. Safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.market_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  price_mnt integer CHECK (price_mnt IS NULL OR price_mnt BETWEEN 0 AND 1000000000),
  phone text CHECK (phone IS NULL OR char_length(phone) BETWEEN 5 AND 24),
  email text CHECK (email IS NULL OR char_length(email) BETWEEN 5 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'removed')),
  report_count integer NOT NULL DEFAULT 0,
  removed_by uuid REFERENCES legacy_x.users (id) ON DELETE SET NULL,
  removed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '45 days'
);
CREATE INDEX IF NOT EXISTS market_listings_status_idx ON legacy_x.market_listings (status, created_at DESC);
CREATE INDEX IF NOT EXISTS market_listings_user_idx ON legacy_x.market_listings (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS legacy_x.market_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES legacy_x.market_listings (id) ON DELETE CASCADE,
  position smallint NOT NULL DEFAULT 0,
  mime text NOT NULL,
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 1572864),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_images_listing_idx ON legacy_x.market_images (listing_id, position);

CREATE TABLE IF NOT EXISTS legacy_x.market_reports (
  listing_id uuid NOT NULL REFERENCES legacy_x.market_listings (id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES legacy_x.users (id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, reporter_id)
);

ALTER TABLE legacy_x.market_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.market_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.market_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.market_listings, legacy_x.market_images, legacy_x.market_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.market_listings, legacy_x.market_images, legacy_x.market_reports TO service_role;

COMMIT;
