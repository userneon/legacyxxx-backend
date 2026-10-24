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

-- The two-colour (gradient) smokes were tried and taken back the same day: the change from grenade to grenade was not noticeable.
-- More single colours instead (2026-10-24). Run the DELETE and the INSERT together; safe to re-run.
DELETE FROM legacy_x.cosmetic_items WHERE id IN ('smoke-aurora', 'smoke-sunrise', 'smoke-ember', 'smoke-glacier')
  AND NOT EXISTS (SELECT 1 FROM legacy_x.cosmetic_owned o WHERE o.item_id = cosmetic_items.id);
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, rarity) VALUES
  ('smoke-slate', 'smoke_color', 'Slate', 'Хөнгөн хөх', 'coin', 150, '', 10, '#64748b', 1),
  ('smoke-olive', 'smoke_color', 'Olive', 'Чидун', 'coin', 200, '', 11, '#65a30d', 1),
  ('smoke-lime', 'smoke_color', 'Lime', 'Шохой ногоон', 'coin', 200, '', 12, '#84cc16', 1),
  ('smoke-mint', 'smoke_color', 'Mint', 'Гүйлс', 'coin', 200, '', 13, '#6ee7b7', 1),
  ('smoke-teal', 'smoke_color', 'Teal', 'Номин', 'coin', 200, '', 14, '#14b8a6', 1),
  ('smoke-cyan', 'smoke_color', 'Cyan', 'Тэнгэр', 'coin', 200, '', 15, '#06b6d4', 1),
  ('smoke-blue', 'smoke_color', 'Blue', 'Цэнхэр', 'coin', 200, '', 16, '#3b82f6', 1),
  ('smoke-indigo', 'smoke_color', 'Indigo', 'Хөх нил', 'coin', 200, '', 17, '#6366f1', 2),
  ('smoke-lavender', 'smoke_color', 'Lavender', 'Лаванд', 'coin', 200, '', 18, '#c4b5fd', 2),
  ('smoke-purple', 'smoke_color', 'Purple', 'Ягаан нил', 'coin', 250, '', 19, '#a855f7', 2),
  ('smoke-magenta', 'smoke_color', 'Magenta', 'Маженд', 'coin', 250, '', 20, '#d946ef', 2),
  ('smoke-red', 'smoke_color', 'Red', 'Улаан', 'coin', 200, '', 21, '#ef4444', 2),
  ('smoke-bloodred', 'smoke_color', 'Blood', 'Цус', 'coin', 250, '', 22, '#991b1b', 2),
  ('smoke-amber', 'smoke_color', 'Amber', 'Хув', 'coin', 250, '', 23, '#f59e0b', 2),
  ('smoke-yellow', 'smoke_color', 'Yellow', 'Шар', 'coin', 250, '', 24, '#facc15', 2),
  ('smoke-peach', 'smoke_color', 'Peach', 'Тоор', 'coin', 200, '', 25, '#fdba74', 2),
  ('smoke-brown', 'smoke_color', 'Brown', 'Хүрэн', 'coin', 200, '', 26, '#92400e', 2),
  ('smoke-navy', 'smoke_color', 'Navy', 'Хар цэнхэр', 'coin', 250, '', 27, '#1e3a8a', 3),
  ('smoke-neon', 'smoke_color', 'Neon', 'Неон', 'coin', 300, '', 28, '#39ff14', 3),
  ('smoke-hotpink', 'smoke_color', 'Hot Pink', 'Час ягаан', 'coin', 300, '', 29, '#ff2d95', 3)
ON CONFLICT (id) DO NOTHING;
