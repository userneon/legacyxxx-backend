-- Premium animated avatar frames (owner request 2026-10-25, "very valuable profile decorations"): six moving frames, the dearest in the
-- Shop. The art is public/frames/<id>.webp on the website (animated WebP, drawn by scripts/premium-frames.html). Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured) VALUES
  ('dragon-ember', 'frame', 'Dragon Ember', 'Лууны гал', 'coin', 2500, '', 40, 4, true),
  ('frost-royale', 'frame', 'Frost Royale', 'Мөсөн хаан', 'coin', 2500, '', 41, 4, true),
  ('void-rift', 'frame', 'Void Rift', 'Хоосон орон зай', 'coin', 3000, '', 42, 4, true),
  ('hologram', 'frame', 'Hologram', 'Голограмм', 'coin', 3500, '', 43, 4, true),
  ('celestial-crown', 'frame', 'Celestial Crown', 'Тэнгэрийн титэм', 'coin', 4000, '', 44, 4, true),
  ('diamond-prestige', 'frame', 'Diamond Prestige', 'Алмаазан нэр хүнд', 'coin', 5000, '', 45, 4, true)
ON CONFLICT (id) DO NOTHING;
