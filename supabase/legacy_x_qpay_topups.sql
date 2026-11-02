-- LX top-ups paid with QPay (replaces the staff-call shop orders for LX packages).
-- One row per QPay invoice. The LX are added once QPay says the invoice is paid; the wallet ref `qpay:<id>` makes that happen only once.
-- Only the Root API (service_role) reads or writes this table. Safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.qpay_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES legacy_x.shop_products(id) ON DELETE RESTRICT,
  amount_mnt integer NOT NULL CHECK (amount_mnt > 0),
  grants_lx integer NOT NULL CHECK (grants_lx > 0),
  qpay_invoice_id text UNIQUE,
  qpay_payment_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS qpay_topups_user_idx ON legacy_x.qpay_topups (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS qpay_topups_status_idx ON legacy_x.qpay_topups (status, created_at);

ALTER TABLE legacy_x.qpay_topups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.qpay_topups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.qpay_topups TO service_role;

COMMIT;
