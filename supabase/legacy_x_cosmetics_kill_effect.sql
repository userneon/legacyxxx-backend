-- Kill effects (owner request 2026-10-25): where a player's victim falls, a short effect in the worn colour plays on the game server,
-- with a flash of light. `fx` is the shape: ring (a ring spreading over the floor), pillar (a beam up into the sky), burst (rays
-- outward), spiral (a rising spiral), lightning (a bolt from above), rainbow (a ring cycling through colours). Under a second, sight
-- lines are not covered and nothing about the kill changes. Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'kill_effect'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'kill_effect'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, fx, rarity) VALUES
  ('kill-ring-white', 'kill_effect', 'Shockwave White', 'Цагаан долгион', 'coin', 400, '', 1, '#f5f5f5', 'ring', 2),
  ('kill-ring-violet', 'kill_effect', 'Shockwave Violet', 'Нил долгион', 'coin', 450, '', 2, '#8b5cf6', 'ring', 2),
  ('kill-ring-red', 'kill_effect', 'Shockwave Red', 'Улаан долгион', 'coin', 450, '', 3, '#ef4444', 'ring', 2),
  ('kill-pillar-ice', 'kill_effect', 'Pillar Ice', 'Мөсөн багана', 'coin', 550, '', 10, '#38bdf8', 'pillar', 3),
  ('kill-pillar-gold', 'kill_effect', 'Pillar Gold', 'Алтан багана', 'coin', 550, '', 11, '#fcd34d', 'pillar', 3),
  ('kill-burst-orange', 'kill_effect', 'Burst Ember', 'Галт цацраг', 'coin', 600, '', 20, '#fb923c', 'burst', 3),
  ('kill-burst-green', 'kill_effect', 'Burst Toxic', 'Хорт цацраг', 'coin', 600, '', 21, '#22c55e', 'burst', 3),
  ('kill-spiral-violet', 'kill_effect', 'Spiral Violet', 'Нил эргүүлэг', 'coin', 700, '', 30, '#a78bfa', 'spiral', 3),
  ('kill-spiral-pink', 'kill_effect', 'Spiral Pink', 'Ягаан эргүүлэг', 'coin', 700, '', 31, '#f472b6', 'spiral', 3),
  ('kill-lightning-ice', 'kill_effect', 'Thunder Ice', 'Мөсөн аянга', 'coin', 800, '', 40, '#7dd3fc', 'lightning', 4),
  ('kill-lightning-violet', 'kill_effect', 'Thunder Violet', 'Нил аянга', 'coin', 800, '', 41, '#8b5cf6', 'lightning', 4),
  ('kill-rainbow', 'kill_effect', 'Prism', 'Солонго', 'coin', 900, '', 50, '#ffffff', 'rainbow', 4)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
