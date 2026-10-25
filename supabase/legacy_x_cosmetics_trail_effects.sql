-- Grenade trails with effects along the way (owner request 2026-10-25): flare (drops burning flares that light what they pass), sparks
-- (sparks fly off the line), starfall (twinkling stars scatter round it), inferno (all three on a thick line). Custom trail can pick them
-- too. Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, fx, rarity) VALUES
  ('trail-flare-red', 'grenade_trail', 'Flare Red', 'Улаан бамбар', 'coin', 700, '', 40, '#ef4444', 'flare', 3),
  ('trail-flare-green', 'grenade_trail', 'Flare Toxic', 'Хорт бамбар', 'coin', 700, '', 41, '#22c55e', 'flare', 3),
  ('trail-sparks-gold', 'grenade_trail', 'Sparks Gold', 'Алтан оч', 'coin', 750, '', 42, '#fcd34d', 'sparks', 3),
  ('trail-sparks-ice', 'grenade_trail', 'Sparks Ice', 'Мөсөн оч', 'coin', 750, '', 43, '#7dd3fc', 'sparks', 3),
  ('trail-starfall-violet', 'grenade_trail', 'Starfall Violet', 'Нил одот бороо', 'coin', 850, '', 44, '#a78bfa', 'starfall', 4),
  ('trail-starfall-white', 'grenade_trail', 'Starfall White', 'Цагаан одот бороо', 'coin', 850, '', 45, '#f5f5f5', 'starfall', 4),
  ('trail-inferno-orange', 'grenade_trail', 'Inferno', 'Тамын гал', 'coin', 1000, '', 46, '#fb923c', 'inferno', 4),
  ('trail-inferno-violet', 'grenade_trail', 'Inferno Violet', 'Нил тамын гал', 'coin', 1000, '', 47, '#8b5cf6', 'inferno', 4)
ON CONFLICT (id) DO NOTHING;
-- Custom trail now offers these shapes, the dearest of them 1,000 LX: it stays 50% above that.
UPDATE legacy_x.cosmetic_items SET price = 1500 WHERE id = 'trail-custom';
