-- Avatar frames are taken out of the site (owner request 2026-11-01: every avatar is a round picture, every frame is refunded).
--   * Every frame item is switched off (it stays in the table, so nothing that points at it breaks; the API ignores owned or worn rows of an item that is off).
--   * Worn frames are taken off.
--   * A player who paid LX for a frame that had not run out gets back what the ledger shows they paid for it (their latest purchase of that frame, once: the ref is per
--     player and frame). A frame with no purchase line in the ledger (given by staff, or bought before the wallet existed) is not paid back: there is nothing to return.
--   * Earned frames (rank, booster, Genesis) are not paid for, so nothing is returned for them.
-- Safe to re-run.

BEGIN;

UPDATE legacy_x.cosmetic_items SET enabled = false WHERE kind = 'frame';
DELETE FROM legacy_x.cosmetic_equipped WHERE kind = 'frame';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.item_id, i.name_en,
           (SELECT -t.amount FROM legacy_x.wallet_transactions t
             WHERE t.user_id = o.user_id AND t.kind = 'spend' AND t.ref LIKE 'cosmetic:' || o.item_id || ':%'
             ORDER BY t.created_at DESC LIMIT 1) AS paid
      FROM legacy_x.cosmetic_owned o JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
     WHERE i.kind = 'frame' AND o.source = 'coin' AND (o.expires_at IS NULL OR o.expires_at > now())
  LOOP
    IF r.paid IS NOT NULL AND r.paid > 0 THEN
      PERFORM legacy_x.wallet_apply(r.user_id, r.paid, 'refund', 'Avatar frames removed: ' || r.name_en, 'frame-removed:' || r.user_id || ':' || r.item_id, NULL);
    END IF;
  END LOOP;
END $$;

DELETE FROM legacy_x.cosmetic_owned o USING legacy_x.cosmetic_items i WHERE i.id = o.item_id AND i.kind = 'frame' AND o.source = 'coin';

COMMIT;
