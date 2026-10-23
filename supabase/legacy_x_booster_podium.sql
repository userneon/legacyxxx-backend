-- The booster podium (owner request 2026-10-23): the three members with the most Discord server boosts wear the Gold, Silver and Bronze
-- booster frames. They are earned, never sold, and follow the ranking on Leaders → Boosters: the API gives each frame to its holder and takes it
-- from anyone who loses the place (when the Discord bot reports, and when a member links Discord). Safe to re-run.
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('booster-gold', 'frame', 'Booster Gold', 'Booster алт', 'achievement', 0, 'The #1 server booster', 40, 4, false, true),
  ('booster-silver', 'frame', 'Booster Silver', 'Booster мөнгө', 'achievement', 0, 'The #2 server booster', 41, 4, false, true),
  ('booster-bronze', 'frame', 'Booster Bronze', 'Booster хүрэл', 'achievement', 0, 'The #3 server booster', 42, 4, false, true)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
