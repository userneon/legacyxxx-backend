-- Discord roles in the Shop (owner request 2026-11-14): decorative roles (no rights) rented for 1, 7 or 30 days like every other cosmetic, only by a player who
-- linked Discord. The bot reads them from the links answer (shopRoles) and gives the role while the rental runs, takes it when it ends. The item id is
-- role-<key>; the key must be one the bot knows (supporter, gold, legend). They start switched OFF: turn each on in Staff -> Shop -> Cosmetics once the bot
-- is deployed. Safe to re-run.
BEGIN;

ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background', 'model_knife', 'model_deagle', 'model_ak47', 'profile_customize', 'discord_role'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, rarity, featured, enabled) VALUES
  ('role-supporter', 'discord_role', 'Supporter', 'Дэмжигч', 'coin', 700, '', 1, '#34d399', 2, false, false),
  ('role-gold', 'discord_role', 'Gold', 'Алт', 'coin', 1500, '', 2, '#e4ae39', 3, true, false),
  ('role-legend', 'discord_role', 'Legend', 'Домог', 'coin', 3000, '', 3, '#eb4b4b', 4, true, false)
ON CONFLICT (id) DO UPDATE SET name_en = EXCLUDED.name_en, name_mn = EXCLUDED.name_mn, unlock = 'coin', price = EXCLUDED.price, sort = EXCLUDED.sort, color = EXCLUDED.color, rarity = EXCLUDED.rarity;

COMMIT;
NOTIFY pgrst, 'reload schema';
