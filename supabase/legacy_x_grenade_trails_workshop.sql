-- Grenade trails, redone (owner request 2026-11-14): the Workshop addon's six particle designs (classic, crack, electric, laser, water, split, built from
-- Letaryat/CS2-CustomTrailAndTracers) replace every older trail: the colour presets, the line, dash, double, helix, comet, rainbow, zigzag, flare, sparks,
-- starfall and inferno shapes, the premium ribbon, lightning, pulse and stardust, and the Custom trail. Each is switched off, taken off every grenade,
-- and the LX that was paid for it goes back to the wallet. Like every colour design, the six are sold as designs and the player picks the colour.
-- The new designs start switched OFF: turn them on in Staff -> Shop -> Cosmetics once the Workshop addon is published and the servers send it.
-- Safe to re-run (a refund is written once per player and item).
BEGIN;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, color2, glow, fx, rarity, featured, enabled) VALUES
  ('trail-classic', 'grenade_trail', 'Classic', 'Сонгодог', 'coin', 900, '', 1, '#d4d4d4', NULL, NULL, 'classic', 3, true, false),
  ('trail-crack', 'grenade_trail', 'Crack', 'Хагарал', 'coin', 1000, '', 2, '#d4d4d4', NULL, NULL, 'crack', 3, false, false),
  ('trail-electric', 'grenade_trail', 'Electric', 'Цахилгаан', 'coin', 1100, '', 3, '#d4d4d4', NULL, NULL, 'electric', 4, true, false),
  ('trail-laser', 'grenade_trail', 'Laser', 'Лазер', 'coin', 950, '', 4, '#d4d4d4', NULL, NULL, 'laser', 3, false, false),
  ('trail-water', 'grenade_trail', 'Water', 'Ус', 'coin', 1000, '', 5, '#d4d4d4', NULL, NULL, 'water', 3, false, false),
  ('trail-split', 'grenade_trail', 'Split', 'Хуваагдал', 'coin', 1200, '', 6, '#d4d4d4', NULL, NULL, 'split', 4, true, false)
ON CONFLICT (id) DO UPDATE SET name_en = EXCLUDED.name_en, name_mn = EXCLUDED.name_mn, unlock = 'coin', price = EXCLUDED.price, sort = EXCLUDED.sort,
  color = EXCLUDED.color, fx = EXCLUDED.fx, rarity = EXCLUDED.rarity, featured = EXCLUDED.featured;

-- Every other trail is retired.
UPDATE legacy_x.cosmetic_items SET enabled = false
 WHERE kind = 'grenade_trail' AND id NOT IN ('trail-classic', 'trail-crack', 'trail-electric', 'trail-laser', 'trail-water', 'trail-split');

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.item_id, i.name_en,
           (SELECT -t.amount FROM legacy_x.wallet_transactions t
             WHERE t.user_id = o.user_id AND t.kind = 'spend' AND t.ref LIKE 'cosmetic:' || o.item_id || ':%'
             ORDER BY t.created_at DESC LIMIT 1) AS paid
      FROM legacy_x.cosmetic_owned o JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
     WHERE i.kind = 'grenade_trail' AND i.id NOT IN ('trail-classic', 'trail-crack', 'trail-electric', 'trail-laser', 'trail-water', 'trail-split')
       AND o.source = 'coin' AND (o.expires_at IS NULL OR o.expires_at > now())
  LOOP
    IF r.paid IS NOT NULL AND r.paid > 0 THEN
      PERFORM legacy_x.wallet_apply(r.user_id, r.paid, 'refund', 'Grenade trails replaced by the new designs: ' || r.name_en, 'trail-removed:' || r.user_id || ':' || r.item_id, NULL);
    END IF;
  END LOOP;
END $$;

DELETE FROM legacy_x.cosmetic_equipped e USING legacy_x.cosmetic_items i
 WHERE i.id = e.item_id AND i.kind = 'grenade_trail' AND i.id NOT IN ('trail-classic', 'trail-crack', 'trail-electric', 'trail-laser', 'trail-water', 'trail-split');
DELETE FROM legacy_x.cosmetic_nade_slot s USING legacy_x.cosmetic_items i
 WHERE i.id = s.item_id AND i.kind = 'grenade_trail' AND i.id NOT IN ('trail-classic', 'trail-crack', 'trail-electric', 'trail-laser', 'trail-water', 'trail-split');
DELETE FROM legacy_x.cosmetic_custom c USING legacy_x.cosmetic_items i
 WHERE i.id = c.item_id AND i.kind = 'grenade_trail' AND i.id NOT IN ('trail-classic', 'trail-crack', 'trail-electric', 'trail-laser', 'trail-water', 'trail-split');
DELETE FROM legacy_x.cosmetic_owned o USING legacy_x.cosmetic_items i
 WHERE i.id = o.item_id AND i.kind = 'grenade_trail' AND i.id NOT IN ('trail-classic', 'trail-crack', 'trail-electric', 'trail-laser', 'trail-water', 'trail-split') AND o.source = 'coin';

COMMIT;
NOTIFY pgrst, 'reload schema';
