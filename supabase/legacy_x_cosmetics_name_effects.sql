-- Premium name looks: `fx` names a finished effect (chrome, gold foil, neon, flame ...) the website draws with its own CSS.
-- Only a short lowercase key is stored and sent; the page ignores any key it does not know. Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS fx text CHECK (fx IS NULL OR fx ~ '^[a-z]{2,20}$');

UPDATE legacy_x.cosmetic_items SET fx = 'neon' WHERE kind = 'name_glow' AND fx IS NULL;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, glow, fx) VALUES
  ('color-chrome', 'name_color', 'Chrome', 'Хром', 'coin', 400, '', 20, '#cbd5e1', NULL, 'chrome'),
  ('color-goldfoil', 'name_color', 'Gold Foil', 'Алтан бүрээс', 'coin', 500, '', 21, '#f5c542', NULL, 'gold'),
  ('color-glacier', 'name_color', 'Glacier', 'Мөсөн уул', 'coin', 450, '', 22, '#7dd3fc', NULL, 'ice'),
  ('color-sakura', 'name_color', 'Sakura', 'Сакура', 'coin', 400, '', 23, '#ff9cbc', NULL, 'sakura'),
  ('color-emerald', 'name_color', 'Emerald', 'Маргад', 'coin', 400, '', 24, '#34d399', NULL, 'emerald'),
  ('color-aurora', 'name_color', 'Aurora', 'Туяа', 'coin', 450, '', 25, '#22d3ee', NULL, 'aurora'),
  ('color-holo', 'name_color', 'Hologram', 'Голограмм', 'coin', 600, '', 26, '#a5f3fc', NULL, 'holo'),
  ('color-inferno', 'name_color', 'Inferno', 'Галт', 'coin', 500, '', 27, '#ff9100', NULL, 'fire'),
  ('color-void', 'name_color', 'Void', 'Хоосон', 'achievement', 0, 'Reach the Apex rank', 28, '#a855f7', NULL, 'void'),
  ('glow-pulse', 'name_glow', 'Crimson Pulse', 'Цохилт', 'coin', 400, '', 20, NULL, '#f43f5e', 'pulse'),
  ('glow-flame', 'name_glow', 'Flame', 'Дөл', 'coin', 450, '', 21, NULL, '#fb923c', 'flame'),
  ('glow-electric', 'name_glow', 'Electric', 'Цахилгаан', 'coin', 450, '', 22, NULL, '#60a5fa', 'electric'),
  ('glow-royal', 'name_glow', 'Royal Aura', 'Хааны туяа', 'coin', 500, '', 23, NULL, '#fbbf24', 'aura')
ON CONFLICT (id) DO NOTHING;
