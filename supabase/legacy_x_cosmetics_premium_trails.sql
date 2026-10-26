-- Premium grenade trails from the Workshop addon (owner request 2026-10-26, legacyxxx-workshop): particle effects tinted with the
-- player's own colour like every design (server/legacyX/cosmeticColours.ts). They start switched OFF: turn each on in Staff → Shop →
-- Cosmetics once the addon is published and the servers send it (legacyxxx-workshop README). Safe to re-run; never switches one back off.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, color2, glow, fx, rarity, featured, enabled) VALUES
  ('trail-pulse', 'grenade_trail', 'Pulse', 'Лугшилт', 'coin', 900, '', 11, '#d4d4d4', NULL, NULL, 'pulse', 4, false, false),
  ('trail-stardust', 'grenade_trail', 'Stardust', 'Одны тоос', 'coin', 1000, '', 12, '#d4d4d4', NULL, NULL, 'stardust', 4, true, false),
  ('trail-ribbon', 'grenade_trail', 'Ribbon', 'Тууз', 'coin', 1100, '', 13, '#d4d4d4', NULL, NULL, 'ribbon', 4, true, false),
  ('trail-lightning', 'grenade_trail', 'Lightning', 'Аянга', 'coin', 1200, '', 14, '#d4d4d4', NULL, NULL, 'lightning', 4, true, false)
ON CONFLICT (id) DO UPDATE SET name_en = EXCLUDED.name_en, name_mn = EXCLUDED.name_mn, unlock = 'coin', price = EXCLUDED.price, sort = EXCLUDED.sort,
  color = EXCLUDED.color, fx = EXCLUDED.fx, rarity = EXCLUDED.rarity;
NOTIFY pgrst, 'reload schema';
