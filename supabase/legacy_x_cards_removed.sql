-- Collectible cards are taken out of the site (owner request 2026-11-02). Every player gets back what their cards are worth today:
-- each copy at the card's current price (base x (1 + held / 25)^2, the price the Shop showed), once per player and card (the ref).
-- Then the cards are switched off and nobody holds one. The tables stay (the trade history), nothing reads them any more. Safe to re-run.

BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.card_id, c.name, o.qty * legacy_x.card_price(c.base_price, c.held) AS value
      FROM legacy_x.card_owned o JOIN legacy_x.cards c ON c.id = o.card_id
  LOOP
    IF r.value > 0 THEN
      PERFORM legacy_x.wallet_apply(r.user_id, r.value, 'refund', 'Cards removed: ' || r.name, 'cards-removed:' || r.user_id || ':' || r.card_id, NULL);
    END IF;
  END LOOP;
END $$;

DELETE FROM legacy_x.card_owned;
UPDATE legacy_x.cards SET enabled = false, held = 0;

COMMIT;
