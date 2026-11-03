-- LX top-ups paid through the Wire gateway (https://wire.mn). One row per top-up; the LX are added once Wire says the payment succeeded, and the
-- wallet ref `topup:wire:<id>` makes that happen only once. Only the Root API (service_role) reads or writes this table. Safe to re-run.
-- (It first existed as `qpay_topups`, from the day the site spoke to QPay itself; that table is renamed here.)
BEGIN;

DO $$
BEGIN
  IF to_regclass('legacy_x.qpay_topups') IS NOT NULL AND to_regclass('legacy_x.wallet_topups') IS NULL THEN
    ALTER TABLE legacy_x.qpay_topups RENAME TO wallet_topups;
    ALTER TABLE legacy_x.wallet_topups RENAME COLUMN qpay_invoice_id TO provider_ref;
    ALTER TABLE legacy_x.wallet_topups DROP COLUMN qpay_payment_id;
    ALTER INDEX IF EXISTS legacy_x.qpay_topups_user_idx RENAME TO wallet_topups_user_idx;
    ALTER INDEX IF EXISTS legacy_x.qpay_topups_status_idx RENAME TO wallet_topups_status_idx;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS legacy_x.wallet_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES legacy_x.shop_products(id) ON DELETE RESTRICT,
  amount_mnt integer NOT NULL CHECK (amount_mnt > 0),
  grants_lx integer NOT NULL CHECK (grants_lx > 0),
  provider_ref text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
ALTER TABLE legacy_x.wallet_topups ADD COLUMN IF NOT EXISTS checkout_url text CHECK (checkout_url IS NULL OR checkout_url ~ '^https://');
CREATE INDEX IF NOT EXISTS wallet_topups_user_idx ON legacy_x.wallet_topups (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_topups_status_idx ON legacy_x.wallet_topups (status, created_at);

ALTER TABLE legacy_x.wallet_topups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.wallet_topups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.wallet_topups TO service_role;

COMMIT;
