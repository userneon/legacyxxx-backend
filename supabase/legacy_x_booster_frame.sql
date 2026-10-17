-- The Server Booster avatar frame: given (never sold) to a member who boosts the LEGACY-X Discord server and has linked Discord to
-- their profile, once, and kept for good. The API grants it when the bot reports the booster or when the member links Discord. Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled)
VALUES ('server-booster', 'frame', 'Server Booster', 'Серверийн дэмжигч', 'achievement', 0, 'Boost the LEGACY-X Discord server', 25, 4, false, true)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
