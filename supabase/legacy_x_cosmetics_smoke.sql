-- Smoke colour cosmetic (2026-10-24): the colour of the player's own smoke grenades in game, bought with LX like a name colour.
-- `color` is a plain #rrggbb value; the game server (LegacyX-Community) reads the worn one from the plugin profile as `smoke_color`.
-- Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, rarity) VALUES
  ('smoke-snow', 'smoke_color', 'Snow', 'Цас', 'free', 0, '', 1, '#e5e5e5', 1),
  ('smoke-emerald', 'smoke_color', 'Emerald', 'Маргад', 'coin', 200, '', 2, '#10b981', 1),
  ('smoke-ice', 'smoke_color', 'Ice', 'Мөс', 'coin', 200, '', 3, '#38bdf8', 1),
  ('smoke-crimson', 'smoke_color', 'Crimson', 'Час улаан', 'coin', 200, '', 4, '#e11d48', 2),
  ('smoke-violet', 'smoke_color', 'Violet', 'Нил', 'coin', 200, '', 5, '#8b5cf6', 2),
  ('smoke-sunset', 'smoke_color', 'Sunset', 'Жаргал', 'coin', 250, '', 6, '#f97316', 2),
  ('smoke-rose', 'smoke_color', 'Rose', 'Сарнай', 'coin', 250, '', 7, '#ec4899', 2),
  ('smoke-gold', 'smoke_color', 'Gold', 'Алт', 'coin', 300, '', 8, '#fbbf24', 3),
  ('smoke-shadow', 'smoke_color', 'Shadow', 'Сүүдэр', 'coin', 300, '', 9, '#27272a', 3)
ON CONFLICT (id) DO NOTHING;

-- Premium two-colour smokes (2026-10-24): `color2` is the second colour of a gradient smoke; the game alternates the two grenade by grenade.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS color2 text CHECK (color2 IS NULL OR color2 ~ '^#[0-9a-f]{6}$');
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, color2, rarity) VALUES
  ('smoke-aurora', 'smoke_color', 'Aurora', 'Туяа', 'coin', 400, '', 10, '#2dd4bf', '#8b5cf6', 4),
  ('smoke-sunrise', 'smoke_color', 'Sunrise', 'Мандах', 'coin', 400, '', 11, '#f97316', '#ec4899', 4),
  ('smoke-ember', 'smoke_color', 'Ember', 'Дөл', 'coin', 450, '', 12, '#e11d48', '#fbbf24', 4),
  ('smoke-glacier', 'smoke_color', 'Glacier', 'Мөсөн гол', 'coin', 400, '', 13, '#38bdf8', '#f5f5f5', 4)
ON CONFLICT (id) DO NOTHING;
