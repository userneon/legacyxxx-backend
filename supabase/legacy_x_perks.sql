-- Paid in-game ranks (owner request 2026-11-07): three tiers bought for 14, 30 or 90 days straight through Wire (QPay and the bank apps).
-- Names and prices are the Owner's decision: the tiers are added NOT for sale (enabled = false, no price); set them with
--   UPDATE legacy_x.perk_tiers SET name = '…', price_14 = …, price_30 = …, price_90 = …, enabled = true WHERE key = 'tier1';
-- (prices in tugrik). The commands each tier may pick are 3, 5 and 10 (server/legacyX/perks.ts); what they may be is in code, not here.

CREATE TABLE IF NOT EXISTS legacy_x.perk_tiers (
  key text PRIMARY KEY CHECK (key IN ('tier1', 'tier2', 'tier3')),
  name text NOT NULL,
  sort int NOT NULL,
  price_14 integer CHECK (price_14 IS NULL OR price_14 > 0),
  price_30 integer CHECK (price_30 IS NULL OR price_30 > 0),
  price_90 integer CHECK (price_90 IS NULL OR price_90 > 0),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO legacy_x.perk_tiers (key, name, sort) VALUES ('tier1', 'Tier 1', 1), ('tier2', 'Tier 2', 2), ('tier3', 'Tier 3', 3) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS legacy_x.perk_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  tier text NOT NULL REFERENCES legacy_x.perk_tiers(key),
  days integer NOT NULL CHECK (days IN (14, 30, 90)),
  amount_mnt integer NOT NULL CHECK (amount_mnt > 0),
  provider_ref text,
  checkout_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS perk_orders_user_idx ON legacy_x.perk_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS perk_orders_provider_idx ON legacy_x.perk_orders (provider_ref);

CREATE TABLE IF NOT EXISTS legacy_x.perk_grants (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  tier text NOT NULL REFERENCES legacy_x.perk_tiers(key),
  ends_at timestamptz NOT NULL,
  commands text[] NOT NULL DEFAULT '{}',
  locked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE legacy_x.perk_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.perk_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.perk_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.perk_tiers, legacy_x.perk_orders, legacy_x.perk_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.perk_tiers, legacy_x.perk_orders, legacy_x.perk_grants TO service_role;
