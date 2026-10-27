-- Twenty more avatar frames (owner request 2026-10-27, art from the owner's frame sheet): painted, ornate frames all at 1,000 LX for 30 days, so 3,000 LX forever (owner request 2026-10-27), between the plain
-- ones (200-700 LX) and the premium ones (2,500-5,000 LX). The art is public/frames/<id>.webp on the website, so they are added switched OFF:
-- deploy the website first, then turn them on with
--   UPDATE legacy_x.cosmetic_items SET enabled = true WHERE id IN (SELECT id FROM legacy_x.cosmetic_items WHERE kind = 'frame' AND sort BETWEEN 50 AND 69);
-- or one by one in Staff → Shop → Cosmetics. Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('sapphire-shards', 'frame', 'Sapphire Shards', 'Индранил болор', 'coin', 1000, '', 50, 3, false, false),
  ('gold-circuit', 'frame', 'Gold Circuit', 'Алтан хэлхээ', 'coin', 1000, '', 51, 3, false, false),
  ('blossom-branch', 'frame', 'Blossom Branch', 'Цэцэглэсэн мөчир', 'coin', 1000, '', 52, 3, false, false),
  ('jasmine-vine', 'frame', 'Jasmine Vine', 'Жасмин ороонго', 'coin', 1000, '', 53, 3, false, false),
  ('iron-chains', 'frame', 'Iron Chains', 'Төмөр гинж', 'coin', 1000, '', 54, 3, false, false),
  ('amethyst-spire', 'frame', 'Amethyst Spire', 'Нил болор шон', 'coin', 1000, '', 55, 3, false, false),
  ('cyber-cyan', 'frame', 'Cyber Cyan', 'Кибер циан', 'coin', 1000, '', 56, 3, false, false),
  ('rose-thorn', 'frame', 'Rose Thorn', 'Сарнайн өргөс', 'coin', 1000, '', 57, 3, false, false),
  ('hellfire-thorns', 'frame', 'Hellfire Thorns', 'Тамын өргөс', 'coin', 1000, '', 58, 3, false, false),
  ('water-surge', 'frame', 'Water Surge', 'Давалгаа', 'coin', 1000, '', 59, 3, false, false),
  ('gilded-thorns', 'frame', 'Gilded Thorns', 'Алтан өргөс', 'coin', 1000, '', 60, 3, false, false),
  ('opal-prism', 'frame', 'Opal Prism', 'Опал призм', 'coin', 1000, '', 61, 3, false, false),
  ('blood-talons', 'frame', 'Blood Talons', 'Цуст сарвуу', 'coin', 1000, '', 62, 3, false, false),
  ('golden-blossom', 'frame', 'Golden Blossom', 'Алтан цэцэг', 'coin', 1000, '', 63, 4, false, false),
  ('void-orb', 'frame', 'Void Orb', 'Хоосон бөмбөрцөг', 'coin', 1000, '', 64, 4, false, false),
  ('black-regalia', 'frame', 'Black Regalia', 'Хар сүлд', 'coin', 1000, '', 65, 4, false, false),
  ('marble-angel', 'frame', 'Marble Angel', 'Гантиг сахиус', 'coin', 1000, '', 66, 4, false, false),
  ('obsidian-dragon', 'frame', 'Obsidian Dragon', 'Хар луу', 'coin', 1000, '', 67, 4, false, false),
  ('royal-drape', 'frame', 'Royal Drape', 'Хаадын хөшиг', 'coin', 1000, '', 68, 4, false, false),
  ('seraph-wings', 'frame', 'Seraph Wings', 'Серафимын далавч', 'coin', 1000, '', 69, 4, false, false)
ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price;
