-- Kill effects over the victim's head (owner request 2026-10-25): halo, crown, cross, xmark (an X), heart (these three face the
-- killer) and soul (a light rising out of the body). Same rules as the other kill effects. Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, fx, rarity) VALUES
  ('kill-halo-gold', 'kill_effect', 'Halo Gold', 'Алтан гэрэл цагираг', 'coin', 500, '', 60, '#fcd34d', 'halo', 3),
  ('kill-halo-white', 'kill_effect', 'Halo White', 'Цагаан гэрэл цагираг', 'coin', 500, '', 61, '#f5f5f5', 'halo', 3),
  ('kill-crown-gold', 'kill_effect', 'Crown Gold', 'Алтан титэм', 'coin', 700, '', 62, '#fcd34d', 'crown', 4),
  ('kill-crown-violet', 'kill_effect', 'Crown Violet', 'Нил титэм', 'coin', 700, '', 63, '#8b5cf6', 'crown', 4),
  ('kill-cross-white', 'kill_effect', 'Rest White', 'Цагаан загалмай', 'coin', 500, '', 64, '#f5f5f5', 'cross', 3),
  ('kill-xmark-red', 'kill_effect', 'Marked Red', 'Улаан X', 'coin', 450, '', 65, '#ef4444', 'xmark', 2),
  ('kill-xmark-green', 'kill_effect', 'Marked Toxic', 'Хорт X', 'coin', 450, '', 66, '#22c55e', 'xmark', 2),
  ('kill-heart-pink', 'kill_effect', 'Heartbreak Pink', 'Ягаан зүрх', 'coin', 600, '', 67, '#f472b6', 'heart', 3),
  ('kill-heart-red', 'kill_effect', 'Heartbreak Red', 'Улаан зүрх', 'coin', 600, '', 68, '#ef4444', 'heart', 3),
  ('kill-soul-ice', 'kill_effect', 'Soul Ice', 'Мөсөн сүнс', 'coin', 750, '', 69, '#7dd3fc', 'soul', 4),
  ('kill-soul-violet', 'kill_effect', 'Soul Violet', 'Нил сүнс', 'coin', 750, '', 70, '#a78bfa', 'soul', 4)
ON CONFLICT (id) DO NOTHING;
