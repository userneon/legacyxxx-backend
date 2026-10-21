-- Real goods in the Shop (NFC charms, stickers): the catalogue and the orders players ask for.
--
-- No payment happens in the app or on the site. A player asks for an item with a phone number; an Owner or Manager contacts them,
-- takes the payment (bank transfer or QPay) and moves the order along: new → contacted → paid → shipped → done (or cancelled).
-- Only the Root API (service_role) reads or writes these tables. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.shop_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 600),
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('charm', 'sticker', 'other')),
  price_mnt integer NOT NULL CHECK (price_mnt >= 0),
  image_url text CHECK (image_url IS NULL OR image_url ~ '^https://'),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  enabled boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.shop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES legacy_x.shop_products(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_mnt integer NOT NULL CHECK (unit_price_mnt >= 0),
  phone text NOT NULL CHECK (phone ~ '^[0-9+ -]{8,20}$'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'paid', 'shipped', 'done', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_orders_user_idx ON legacy_x.shop_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_orders_status_idx ON legacy_x.shop_orders (status, created_at);

ALTER TABLE legacy_x.shop_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.shop_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.shop_products, legacy_x.shop_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.shop_products, legacy_x.shop_orders TO service_role;

COMMIT;
