-- Zigzag grenade trail (owner request 2026-10-25): two lines zigzag to either side of the flight and cross along the way. Custom trail
-- can pick it too. Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, fx, rarity) VALUES
  ('trail-zigzag-violet', 'grenade_trail', 'Zigzag Violet', 'Нил зигзаг', 'coin', 650, '', 35, '#8b5cf6', 'zigzag', 3),
  ('trail-zigzag-ice', 'grenade_trail', 'Zigzag Ice', 'Мөсөн зигзаг', 'coin', 650, '', 36, '#7dd3fc', 'zigzag', 3),
  ('trail-zigzag-red', 'grenade_trail', 'Zigzag Red', 'Улаан зигзаг', 'coin', 650, '', 37, '#ef4444', 'zigzag', 3),
  ('trail-zigzag-white', 'grenade_trail', 'Zigzag White', 'Цагаан зигзаг', 'coin', 600, '', 38, '#f5f5f5', 'zigzag', 3)
ON CONFLICT (id) DO NOTHING;
