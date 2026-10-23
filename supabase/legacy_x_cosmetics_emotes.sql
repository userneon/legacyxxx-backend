-- Retired on 2026-10-23: emotes are gone from the game and the site. Run legacy_x_remove_emotes.sql after this file.
-- Emotes, next to frames and name styles: a short line (and sound) a player plays in game with .e. Same rules as the other cosmetics:
-- (the kind list already includes banner and title from legacy_x_founder.sql, so this file stays safe to re-run after it).
-- free / coin (bought once with LX) / achievement (earned). `fx` is the key the game plugin knows the emote by; nothing else is sent to a page or server.
-- `game_key` is the name the animated-emote plugin knows an emote by (any text); it takes the place of `fx` for those.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS game_key text CHECK (game_key IS NULL OR char_length(game_key) BETWEEN 1 AND 80);
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, fx, rarity) VALUES
  ('emote-gg', 'emote', 'GG', 'GG', 'free', 0, '', 1, 'gg', 1),
  ('emote-hello', 'emote', 'Hello', 'Сайн уу', 'coin', 100, '', 2, 'hello', 1),
  ('emote-gl', 'emote', 'Good Luck', 'Амжилт', 'coin', 100, '', 3, 'gl', 1),
  ('emote-nice', 'emote', 'Nice Shot', 'Сайн буудлаа', 'coin', 150, '', 4, 'nice', 2),
  ('emote-clap', 'emote', 'Applause', 'Алга ташилт', 'coin', 150, '', 5, 'clap', 2),
  ('emote-salute', 'emote', 'Salute', 'Мэндчилгээ', 'coin', 200, '', 6, 'salute', 2),
  ('emote-fire', 'emote', 'On Fire', 'Галтай', 'coin', 250, '', 7, 'fire', 3),
  ('emote-legacy', 'emote', 'Legacy', 'Legacy', 'achievement', 0, 'Reach the Legacy rank', 8, 'legacy', 4)
ON CONFLICT (id) DO NOTHING;
