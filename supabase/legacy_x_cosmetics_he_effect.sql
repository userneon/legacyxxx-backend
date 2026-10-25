-- HE grenade explosion effects (owner request 2026-10-25): on top of the game's own blast, a short effect in the worn colour with a wide
-- flash of light. `fx` is the shape: shockwave (a ring rushing out along the floor), dome (rings rising like a half sphere), burst
-- (rays out and up), embers (glowing embers thrown up and falling), prism (rays in every colour). About half a second; the blast, its
-- damage and its sound stay the game's own. Custom explosion picks colour and shape (50% above the dearest). Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'kill_effect', 'flash_effect', 'he_effect'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'kill_effect', 'flash_effect', 'he_effect'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, fx, rarity) VALUES
  ('he-shockwave-white', 'he_effect', 'Shockwave White', 'Цагаан долгион', 'coin', 450, '', 1, '#f5f5f5', 'shockwave', 2),
  ('he-shockwave-red', 'he_effect', 'Shockwave Red', 'Улаан долгион', 'coin', 500, '', 2, '#ef4444', 'shockwave', 2),
  ('he-dome-violet', 'he_effect', 'Dome Violet', 'Нил бөмбөгөр', 'coin', 600, '', 10, '#8b5cf6', 'dome', 3),
  ('he-dome-ice', 'he_effect', 'Dome Ice', 'Мөсөн бөмбөгөр', 'coin', 600, '', 11, '#7dd3fc', 'dome', 3),
  ('he-burst-gold', 'he_effect', 'Burst Gold', 'Алтан цацраг', 'coin', 650, '', 20, '#fcd34d', 'burst', 3),
  ('he-burst-green', 'he_effect', 'Burst Toxic', 'Хорт цацраг', 'coin', 650, '', 21, '#22c55e', 'burst', 3),
  ('he-embers-orange', 'he_effect', 'Embers', 'Цог', 'coin', 750, '', 30, '#fb923c', 'embers', 4),
  ('he-embers-violet', 'he_effect', 'Embers Violet', 'Нил цог', 'coin', 750, '', 31, '#a78bfa', 'embers', 4),
  ('he-prism', 'he_effect', 'Prism', 'Солонго', 'coin', 850, '', 40, '#ffffff', 'prism', 4),
  ('he-custom', 'he_effect', 'Custom explosion', 'Өөрийн дэлбэрэлт', 'coin', 1125, '', 90, '#8b5cf6', 'shockwave', 4)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
