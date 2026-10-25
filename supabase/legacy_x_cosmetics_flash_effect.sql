-- Flash effects (owner request 2026-10-25): where a player's flashbang bursts, a short effect in the worn colour with a flash of light.
-- `fx` is the shape: starburst (rays every way), nova (three rings like a sphere), ring (a shockwave along the floor), prism (rays in
-- every colour). Under half a second; who is blinded and for how long stays the game's own. Custom flash picks colour and shape
-- (50% above the dearest). Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'kill_effect', 'flash_effect'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'kill_effect', 'flash_effect'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, fx, rarity) VALUES
  ('flash-starburst-white', 'flash_effect', 'Starburst White', 'Цагаан туяа', 'coin', 400, '', 1, '#f5f5f5', 'starburst', 2),
  ('flash-starburst-gold', 'flash_effect', 'Starburst Gold', 'Алтан туяа', 'coin', 450, '', 2, '#fcd34d', 'starburst', 2),
  ('flash-starburst-violet', 'flash_effect', 'Starburst Violet', 'Нил туяа', 'coin', 450, '', 3, '#8b5cf6', 'starburst', 2),
  ('flash-nova-ice', 'flash_effect', 'Nova Ice', 'Мөсөн нова', 'coin', 550, '', 10, '#7dd3fc', 'nova', 3),
  ('flash-nova-red', 'flash_effect', 'Nova Red', 'Улаан нова', 'coin', 550, '', 11, '#ef4444', 'nova', 3),
  ('flash-ring-green', 'flash_effect', 'Shockwave Toxic', 'Хорт долгион', 'coin', 500, '', 20, '#22c55e', 'ring', 2),
  ('flash-ring-orange', 'flash_effect', 'Shockwave Ember', 'Галт долгион', 'coin', 500, '', 21, '#fb923c', 'ring', 2),
  ('flash-prism', 'flash_effect', 'Prism', 'Солонго', 'coin', 750, '', 30, '#ffffff', 'prism', 4),
  ('flash-custom', 'flash_effect', 'Custom flash', 'Өөрийн flash', 'coin', 825, '', 90, '#8b5cf6', 'starburst', 4)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
