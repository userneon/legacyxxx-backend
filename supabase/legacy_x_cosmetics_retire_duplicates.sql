-- Plain name colours that look the same as another one are switched off (owner request 2026-10-22). Each pair is within about 30 steps in RGB,
-- so on screen they read as one colour; the cheaper-to-keep one stays:
--   Sunset (#fdba74) keeps, Apricot (#fbbf77) goes      Pearl (#f5f5f4) keeps, Snow (#f8fafc) goes
--   Steel (#94a3b8) keeps, Graphite (#a3a3a3) goes      Rose (#fda4af) keeps, Peach (#fdba9a) goes
-- A switched-off item stays in the table, so nothing that points at it breaks; the API ignores owned or worn rows of an item that is off.
-- Anyone who paid coins for one gets them back, once (the ref is per player and item). Safe to re-run.

BEGIN;

UPDATE legacy_x.cosmetic_items SET enabled = false
 WHERE kind = 'name_color' AND id IN ('color-apricot', 'color-snow', 'color-graphite', 'color-peach');

DELETE FROM legacy_x.cosmetic_equipped
 WHERE kind = 'name_color' AND item_id IN ('color-apricot', 'color-snow', 'color-graphite', 'color-peach');

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.item_id, i.price, i.name_en
      FROM legacy_x.cosmetic_owned o JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
     WHERE i.kind = 'name_color' AND i.enabled = false AND o.source = 'coin' AND i.price > 0
       AND i.id IN ('color-apricot', 'color-snow', 'color-graphite', 'color-peach')
  LOOP
    PERFORM legacy_x.wallet_apply(r.user_id, r.price, 'refund', 'Name colour retired: ' || r.name_en, 'cosmetic:' || r.item_id || ':retired', NULL);
  END LOOP;
END $$;

COMMIT;
