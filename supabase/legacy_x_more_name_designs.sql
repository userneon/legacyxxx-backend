-- More name designs (owner request 2026-11-02): seven colour designs and eight glows, all coloured by the player like the others
-- (server/legacyX/cosmeticColours.ts needs no change: any coin item of these kinds without a fixed fx takes a picked colour).
-- The looks themselves are drawn by the website's name-effects.css, so apply this AFTER the website is deployed. Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, color2, glow, fx, rarity, enabled) VALUES
  ('name-pastel', 'name_color', 'Pastel', 'Зөөлөн', 'coin', 300, '', 7, '#d4d4d4', NULL, NULL, 'pastel', 1, true),
  ('name-split', 'name_color', 'Split', 'Хуваа', 'coin', 400, '', 8, '#d4d4d4', NULL, NULL, 'split', 2, true),
  ('name-stripes', 'name_color', 'Stripes', 'Судал', 'coin', 400, '', 9, '#d4d4d4', NULL, NULL, 'stripes', 2, true),
  ('name-duo', 'name_color', 'Duo', 'Хос', 'coin', 450, '', 10, '#d4d4d4', NULL, NULL, 'duo', 2, true),
  ('name-gloss', 'name_color', 'Gloss', 'Гялс', 'coin', 500, '', 11, '#d4d4d4', NULL, NULL, 'gloss', 3, true),
  ('name-frost', 'name_color', 'Frost', 'Шүүдэр', 'coin', 550, '', 12, '#d4d4d4', NULL, NULL, 'frost', 3, true),
  ('name-wave', 'name_color', 'Wave', 'Давалгаа', 'coin', 650, '', 13, '#d4d4d4', NULL, NULL, 'wave', 4, true),
  ('glow-ring', 'name_glow', 'Ring', 'Хүрээ', 'coin', 300, '', 9, NULL, NULL, '#d4d4d4', 'ring', 1, true),
  ('glow-drop', 'name_glow', 'Drop', 'Сүүдэр', 'coin', 350, '', 10, NULL, NULL, '#d4d4d4', 'drop', 1, true),
  ('glow-bloom', 'name_glow', 'Bloom', 'Цэцэглэлт', 'coin', 450, '', 11, NULL, NULL, '#d4d4d4', 'bloom', 2, true),
  ('glow-twinkle', 'name_glow', 'Twinkle', 'Гялбаа', 'coin', 450, '', 12, NULL, NULL, '#d4d4d4', 'twinkle', 2, true),
  ('glow-sway', 'name_glow', 'Sway', 'Найгалт', 'coin', 500, '', 13, NULL, NULL, '#d4d4d4', 'sway', 3, true),
  ('glow-ripple', 'name_glow', 'Ripple', 'Долгио', 'coin', 500, '', 14, NULL, NULL, '#d4d4d4', 'ripple', 3, true),
  ('glow-heartbeat', 'name_glow', 'Heartbeat', 'Зүрхний цохилт', 'coin', 550, '', 15, NULL, NULL, '#d4d4d4', 'heartbeat', 3, true),
  ('glow-strobe', 'name_glow', 'Strobe', 'Анивчилт', 'coin', 600, '', 16, NULL, NULL, '#d4d4d4', 'strobe', 4, true)
ON CONFLICT (id) DO UPDATE SET name_en = EXCLUDED.name_en, name_mn = EXCLUDED.name_mn, unlock = 'coin', price = EXCLUDED.price, sort = EXCLUDED.sort,
  color = EXCLUDED.color, glow = EXCLUDED.glow, fx = EXCLUDED.fx, rarity = EXCLUDED.rarity;
