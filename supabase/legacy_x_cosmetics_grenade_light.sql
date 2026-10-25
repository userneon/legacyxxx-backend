-- Grenade trail shapes and the Grenade light (owner request 2026-10-25). A trail's `fx` is its shape on the game server: line (default),
-- dash, double, helix, comet, rainbow. A grenade light is a coloured light that flies with the player's grenades, sold on its own.
-- Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, fx, rarity) VALUES
  ('trail-dash-white', 'grenade_trail', 'Morse White', 'Морз цагаан', 'coin', 350, '', 20, '#f5f5f5', 'dash', 2),
  ('trail-dash-violet', 'grenade_trail', 'Morse Violet', 'Морз нил', 'coin', 350, '', 21, '#8b5cf6', 'dash', 2),
  ('trail-double-ice', 'grenade_trail', 'Twin Ice', 'Ихэр мөс', 'coin', 450, '', 22, '#38bdf8', 'double', 3),
  ('trail-double-red', 'grenade_trail', 'Twin Red', 'Ихэр улаан', 'coin', 450, '', 23, '#ef4444', 'double', 3),
  ('trail-helix-gold', 'grenade_trail', 'Helix Gold', 'Мушгиа алт', 'coin', 600, '', 24, '#fcd34d', 'helix', 3),
  ('trail-helix-green', 'grenade_trail', 'Helix Toxic', 'Мушгиа хорт', 'coin', 600, '', 25, '#84cc16', 'helix', 3),
  ('trail-comet-orange', 'grenade_trail', 'Comet Ember', 'Сүүлт од галт', 'coin', 500, '', 26, '#fb923c', 'comet', 3),
  ('trail-comet-violet', 'grenade_trail', 'Comet Violet', 'Сүүлт од нил', 'coin', 500, '', 27, '#a78bfa', 'comet', 3),
  ('trail-rainbow', 'grenade_trail', 'Rainbow', 'Солонго', 'coin', 800, '', 30, '#ffffff', 'rainbow', 4),
  ('light-white', 'grenade_light', 'Flare White', 'Цагаан гэрэл', 'coin', 300, '', 1, '#f5f5f5', NULL, 2),
  ('light-violet', 'grenade_light', 'Flare Violet', 'Нил гэрэл', 'coin', 350, '', 2, '#8b5cf6', NULL, 2),
  ('light-red', 'grenade_light', 'Flare Red', 'Улаан гэрэл', 'coin', 350, '', 3, '#ef4444', NULL, 2),
  ('light-orange', 'grenade_light', 'Flare Ember', 'Галт гэрэл', 'coin', 350, '', 4, '#fb923c', NULL, 2),
  ('light-green', 'grenade_light', 'Flare Toxic', 'Хорт гэрэл', 'coin', 350, '', 5, '#22c55e', NULL, 2),
  ('light-ice', 'grenade_light', 'Flare Ice', 'Мөсөн гэрэл', 'coin', 350, '', 6, '#38bdf8', NULL, 2),
  ('light-gold', 'grenade_light', 'Flare Gold', 'Алтан гэрэл', 'coin', 400, '', 7, '#fcd34d', NULL, 3),
  ('light-pink', 'grenade_light', 'Flare Pink', 'Ягаан гэрэл', 'coin', 400, '', 8, '#f472b6', NULL, 3)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
