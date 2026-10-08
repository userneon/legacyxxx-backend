-- Name colour and name glow cosmetics, next to avatar frames. Purely visual, same rules: free / coin (bought once) / achievement (earned).
-- `color` and `glow` are plain #rrggbb values the website paints the player's name with; nothing else is ever sent to the page as a style.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$');
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS glow text CHECK (glow IS NULL OR glow ~ '^#[0-9a-f]{6}$');
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, glow) VALUES
  ('color-silver', 'name_color', 'Silver', 'Мөнгөн', 'free', 0, '', 1, '#cbd5e1', NULL),
  ('color-ice', 'name_color', 'Ice', 'Мөс', 'coin', 150, '', 2, '#7dd3fc', NULL),
  ('color-mint', 'name_color', 'Mint', 'Гүйлс', 'coin', 150, '', 3, '#86efac', NULL),
  ('color-rose', 'name_color', 'Rose', 'Сарнай', 'coin', 150, '', 4, '#fda4af', NULL),
  ('color-violet', 'name_color', 'Violet', 'Нил', 'coin', 200, '', 5, '#c4b5fd', NULL),
  ('color-sunset', 'name_color', 'Sunset', 'Жаргал', 'coin', 200, '', 6, '#fdba74', NULL),
  ('color-gold', 'name_color', 'Gold', 'Алт', 'coin', 300, '', 7, '#fcd34d', NULL),
  ('color-ember', 'name_color', 'Ember', 'Гал', 'achievement', 0, 'Season 1 winner', 8, '#ff6b4a', NULL),
  ('glow-white', 'name_glow', 'Soft White', 'Цагаан гэрэл', 'coin', 250, '', 1, NULL, '#ffffff'),
  ('glow-ice', 'name_glow', 'Ice', 'Мөсөн гэрэл', 'coin', 250, '', 2, NULL, '#38bdf8'),
  ('glow-mint', 'name_glow', 'Mint', 'Гүйлс гэрэл', 'coin', 250, '', 3, NULL, '#4ade80'),
  ('glow-crimson', 'name_glow', 'Crimson', 'Час улаан', 'coin', 300, '', 4, NULL, '#f43f5e'),
  ('glow-violet', 'name_glow', 'Violet', 'Нил гэрэл', 'coin', 300, '', 5, NULL, '#a78bfa'),
  ('glow-gold', 'name_glow', 'Gold', 'Алтан гэрэл', 'coin', 350, '', 6, NULL, '#fbbf24'),
  ('glow-aurora', 'name_glow', 'Aurora', 'Туяа', 'achievement', 0, 'Clan tournament winner', 7, NULL, '#2dd4bf')
ON CONFLICT (id) DO NOTHING;
