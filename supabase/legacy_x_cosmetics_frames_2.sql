-- Second set of avatar frames (24). The first set is switched off (kept, so nothing that points at it breaks) and nobody wears it any more.
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE kind = 'frame' AND id IN ('red-dragon','crimson-thorns','shattered-glass','frost-ring','white-lily','inferno','blood-moon','violet-moon','sakura-silk','cyber-violet','oni-samurai','emerald-dragon','golden-crown','raven-wing','ghost-skull','eclipse');
-- Worn or owned rows that still point at a switched-off frame are ignored by the API, so nothing has to be deleted.
-- Anyone who paid coins for a frame of the first set gets those coins back (once: the ref is per player and frame).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.item_id, i.price, i.name_en
      FROM legacy_x.cosmetic_owned o JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
     WHERE i.kind = 'frame' AND i.enabled = false AND o.source = 'coin' AND i.price > 0
  LOOP
    PERFORM legacy_x.wallet_apply(r.user_id, r.price, 'refund', 'Frame replaced by the new set: ' || r.name_en, 'cosmetic:' || r.item_id || ':replaced', NULL);
  END LOOP;
END $$;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort) VALUES
  ('starlight-corners', 'frame', 'Starlight Corners', 'Одны булан', 'free', 0, '', 1),
  ('torn-tape', 'frame', 'Torn Tape', 'Урагдсан тууз', 'free', 0, '', 2),
  ('red-circuit', 'frame', 'Red Circuit', 'Улаан хэлхээ', 'free', 0, '', 3),
  ('shattered-crystal', 'frame', 'Shattered Crystal', 'Хагарсан болор', 'free', 0, '', 4),
  ('charcoal-ring', 'frame', 'Charcoal Ring', 'Нүүрсэн цагираг', 'coin', 200, '', 5),
  ('barbed-wire', 'frame', 'Barbed Wire', 'Өргөст утас', 'coin', 200, '', 6),
  ('silent-waves', 'frame', 'Silent Waves', 'Чимээгүй давалгаа', 'coin', 200, '', 7),
  ('neon-violet', 'frame', 'Neon Violet', 'Нил неон', 'coin', 250, '', 8),
  ('graffiti', 'frame', 'Graffiti', 'Граффити', 'coin', 250, '', 9),
  ('liquid-metal', 'frame', 'Liquid Metal', 'Шингэн металл', 'coin', 300, '', 10),
  ('chain-and-tag', 'frame', 'Chain and Tag', 'Гинж ба тэмдэг', 'coin', 300, '', 11),
  ('sakura-blossom', 'frame', 'Sakura Blossom', 'Сакура цэцэг', 'coin', 350, '', 12),
  ('blue-lightning', 'frame', 'Blue Lightning', 'Хөх аянга', 'coin', 350, '', 13),
  ('crimson-lightning', 'frame', 'Crimson Lightning', 'Улаан аянга', 'coin', 350, '', 14),
  ('toxic-lightning', 'frame', 'Toxic Lightning', 'Хортой аянга', 'coin', 350, '', 15),
  ('prism-glass', 'frame', 'Prism Glass', 'Призм шил', 'coin', 400, '', 16),
  ('blood-vine', 'frame', 'Blood Vine', 'Цусан ороонго', 'coin', 400, '', 17),
  ('film-and-butterflies', 'frame', 'Film and Butterflies', 'Хальс ба эрвээхэй', 'coin', 400, '', 18),
  ('planet-orbit', 'frame', 'Planet Orbit', 'Гараг тойрог', 'coin', 450, '', 19),
  ('ice-crystals', 'frame', 'Ice Crystals', 'Мөсөн болор', 'coin', 450, '', 20),
  ('golden-moon', 'frame', 'Golden Moon', 'Алтан сар', 'achievement', 0, 'Reach the Legacy rank', 21),
  ('angel-wings', 'frame', 'Angel Wings', 'Сахиусны жигүүр', 'achievement', 0, 'Reach the Apex rank', 22),
  ('eclipse-clouds', 'frame', 'Eclipse Clouds', 'Хиртэлтийн үүл', 'achievement', 0, 'Clan tournament winner', 23),
  ('glitch', 'frame', 'Glitch', 'Глич', 'achievement', 0, 'Season 1 winner', 24)
ON CONFLICT (id) DO NOTHING;
