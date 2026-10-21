-- A calmer, more premium set (owner decision 2026-10-21). Frames that look violent or grungy are switched off, and the ones with
-- a harsh name are renamed. Safe to re-run.
--
-- A switched-off frame is kept in the table, so nothing that points at it breaks; the API ignores owned or worn rows of a frame that
-- is off. Anyone who paid coins for one gets the coins back, once (the ref is per player and frame).

BEGIN;

UPDATE legacy_x.cosmetic_items SET enabled = false
 WHERE kind = 'frame' AND id IN ('barbed-wire', 'blood-vine', 'chain-and-tag', 'shattered-crystal', 'torn-tape', 'graffiti');

UPDATE legacy_x.cosmetic_items SET name_en = 'Green Lightning', name_mn = 'Ногоон аянга' WHERE id = 'toxic-lightning';
UPDATE legacy_x.cosmetic_items SET name_en = 'Lime', name_mn = 'Лайм' WHERE id = 'color-toxic';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.item_id, i.price, i.name_en
      FROM legacy_x.cosmetic_owned o JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
     WHERE i.kind = 'frame' AND i.enabled = false AND o.source = 'coin' AND i.price > 0
       AND i.id IN ('barbed-wire', 'blood-vine', 'chain-and-tag', 'shattered-crystal', 'torn-tape', 'graffiti')
  LOOP
    PERFORM legacy_x.wallet_apply(r.user_id, r.price, 'refund', 'Frame retired: ' || r.name_en, 'cosmetic:' || r.item_id || ':retired', NULL);
  END LOOP;
END $$;

COMMIT;
