-- Grenade trail cosmetic (owner request 2026-10-25): a coloured line follows the player's own grenades through the air on the game
-- server (LegacyX-Community draws it). `color` is a plain #rrggbb; the plugin reads the worn one from the player profile as `grenade_trail`.
-- Sold like the smoke colours (rentals). Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, rarity) VALUES
  ('trail-white', 'grenade_trail', 'White', 'Цагаан', 'coin', 150, '', 1, '#f5f5f5', 1),
  ('trail-violet', 'grenade_trail', 'Violet', 'Нил', 'coin', 200, '', 2, '#8b5cf6', 1),
  ('trail-red', 'grenade_trail', 'Red', 'Улаан', 'coin', 200, '', 3, '#ef4444', 1),
  ('trail-orange', 'grenade_trail', 'Orange', 'Улбар шар', 'coin', 200, '', 4, '#fb923c', 1),
  ('trail-gold', 'grenade_trail', 'Gold', 'Алт', 'coin', 250, '', 5, '#fcd34d', 2),
  ('trail-lime', 'grenade_trail', 'Lime', 'Шохой ногоон', 'coin', 200, '', 6, '#84cc16', 1),
  ('trail-green', 'grenade_trail', 'Green', 'Ногоон', 'coin', 200, '', 7, '#22c55e', 1),
  ('trail-teal', 'grenade_trail', 'Teal', 'Номин', 'coin', 200, '', 8, '#2dd4bf', 1),
  ('trail-ice', 'grenade_trail', 'Ice', 'Мөс', 'coin', 200, '', 9, '#38bdf8', 1),
  ('trail-blue', 'grenade_trail', 'Blue', 'Цэнхэр', 'coin', 200, '', 10, '#3b82f6', 1),
  ('trail-pink', 'grenade_trail', 'Pink', 'Ягаан', 'coin', 250, '', 11, '#f472b6', 2),
  ('trail-crimson', 'grenade_trail', 'Crimson', 'Час улаан', 'coin', 250, '', 12, '#e11d48', 2)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
