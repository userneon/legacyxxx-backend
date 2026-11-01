-- The Genesis pack is taken out (owner request 2026-11-01: its colour and look are changing, so it is removed and refunded).
--   * The product is switched off, so it cannot be bought or ordered any more.
--   * The Genesis frame, Gold Foil banner and Genesis title are taken off everyone (worn or owned) and switched off; the Genesis numbers are cleared.
--   * What buyers paid is returned in LX, once per player: a pack bought with LX gets exactly what the ledger shows; a pack paid for in MNT (a paid shop order,
--     30,000 MNT) gets 4,500 LX, the rate the pack's LX price was set at. A pack that staff gave (no payment on record) returns nothing.
-- Safe to re-run.

BEGIN;

UPDATE legacy_x.shop_products SET enabled = false WHERE kind = 'founder';

DO $$
DECLARE r record;
BEGIN
  -- Bought with LX from the wallet.
  FOR r IN
    SELECT t.user_id, -t.amount AS paid FROM legacy_x.wallet_transactions t WHERE t.kind = 'spend' AND t.ref LIKE 'founder:%'
  LOOP
    PERFORM legacy_x.wallet_apply(r.user_id, r.paid, 'refund', 'Genesis pack removed', 'genesis-removed:' || r.user_id, NULL);
  END LOOP;
  -- Paid for in MNT through a shop order that staff marked paid (and nothing returned above).
  FOR r IN
    SELECT f.user_id FROM legacy_x.founders f JOIN legacy_x.shop_orders o ON o.id = f.order_id
     WHERE o.status = 'paid'
       AND NOT EXISTS (SELECT 1 FROM legacy_x.wallet_transactions t WHERE t.user_id = f.user_id AND t.kind = 'spend' AND t.ref LIKE 'founder:%')
  LOOP
    PERFORM legacy_x.wallet_apply(r.user_id, 4500, 'refund', 'Genesis pack removed', 'genesis-removed:' || r.user_id, NULL);
  END LOOP;
END $$;

DELETE FROM legacy_x.cosmetic_equipped WHERE item_id IN ('founder', 'banner-gold-foil', 'title-founder');
DELETE FROM legacy_x.cosmetic_owned WHERE item_id IN ('founder', 'banner-gold-foil', 'title-founder');
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE id IN ('founder', 'banner-gold-foil', 'title-founder');
DELETE FROM legacy_x.founders;

COMMIT;
