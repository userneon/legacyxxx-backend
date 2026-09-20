-- Removes the store, the wallet and the promotion system from the database.
--
-- The website, the API and the staff panel no longer contain any of it. Every table below held 0
-- rows at the time of writing, and every function below exists only to move coins between them.
--
-- Promotions go too: each of their contexts was a wallet top-up, a wallet redemption or a store
-- purchase, so with both features gone a promotion code has nothing to apply to.
--
-- Irreversible. Take a snapshot first if there is any chance of wanting this back.

BEGIN;

/* ---------------------------------------------------------------------------
 * Functions first: they depend on the tables.
 * ------------------------------------------------------------------------ */

DROP FUNCTION IF EXISTS legacy_x.purchase_store_item_with_promotion(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS legacy_x.purchase_store_item(uuid, uuid);
DROP FUNCTION IF EXISTS legacy_x.redeem_promotion_code(uuid, text, text);
DROP FUNCTION IF EXISTS legacy_x.quote_promotion_code(uuid, text, text, integer, uuid);
DROP FUNCTION IF EXISTS legacy_x.credit_wallet(uuid, integer, text);

-- Any overload the signatures above missed.
DO $$
DECLARE fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'legacy_x'
      AND p.proname IN ('credit_wallet', 'purchase_store_item', 'purchase_store_item_with_promotion',
                        'quote_promotion_code', 'redeem_promotion_code')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', fn.signature);
  END LOOP;
END $$;

/* ---------------------------------------------------------------------------
 * Tables
 * ------------------------------------------------------------------------ */

DROP TABLE IF EXISTS legacy_x.store_purchases;
DROP TABLE IF EXISTS legacy_x.store_items;
DROP TABLE IF EXISTS legacy_x.wallet_transactions;
DROP TABLE IF EXISTS legacy_x.promotion_redemptions;
DROP TABLE IF EXISTS legacy_x.promotion_codes;
DROP TABLE IF EXISTS legacy_x.promotion_campaigns;
-- Entitlements only ever came from a redeemed promotion code.
DROP TABLE IF EXISTS legacy_x.user_entitlements;

/* ---------------------------------------------------------------------------
 * The coin balance on a player
 * ------------------------------------------------------------------------ */

ALTER TABLE legacy_x.users DROP COLUMN IF EXISTS balance;

COMMIT;

-- Verification: all of these must come back NULL / 0.
-- SELECT to_regclass('legacy_x.store_items'), to_regclass('legacy_x.wallet_transactions'),
--        to_regclass('legacy_x.promotion_campaigns'), to_regclass('legacy_x.user_entitlements');
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema = 'legacy_x' AND table_name = 'users' AND column_name = 'balance';
