-- Colour it yourself (owner request 2026-10-26): every coloured player cosmetic is sold as a design only and the player picks its colour
-- (server/legacyX/cosmeticColours.ts). One item per design replaces the colour variants. Whoever owned a variant now owns its design,
-- for at least as long, with the variant's colour as their pick, and still wears it. The old variants are switched off, not deleted.
-- Fixed-look designs (rainbow trail, prism flash, spectrum name) and earned items are untouched. Safe to re-run.

BEGIN;

ALTER TABLE legacy_x.cosmetic_custom ADD COLUMN IF NOT EXISTS color2 text CHECK (color2 IS NULL OR color2 ~ '^#[0-9a-f]{6}$');

-- Which design each old colour variant becomes, per owner (a custom item keeps the shape and colour its owner picked).
CREATE TEMP TABLE colour_moves ON COMMIT DROP AS
SELECT o.user_id, o.item_id AS old_id, o.expires_at, o.source, o.acquired_at,
  CASE i.kind
    WHEN 'name_color' THEN CASE
      WHEN i.id = 'name-custom' OR i.fx IS NULL THEN 'name-solid'
      WHEN i.fx IN ('fire', 'lava') THEN 'name-fire'
      WHEN i.fx = 'chrome' THEN 'name-chrome'
      WHEN i.fx IN ('gold', 'rosegold', 'platinum') THEN 'name-foil'
      WHEN i.fx IN ('aurora', 'holo', 'candy', 'galaxy') THEN 'name-drift'
      ELSE 'name-gradient' END
    WHEN 'name_glow' THEN CASE WHEN i.id = 'glow-custom' THEN 'glow-neon' ELSE 'glow-' || coalesce(i.fx, 'neon') END
    WHEN 'smoke_color' THEN CASE WHEN i.color2 IS NOT NULL THEN 'smoke-dual' ELSE 'smoke-solid' END
    WHEN 'grenade_trail' THEN 'trail-' || coalesce(nullif(c.fx, ''), nullif(i.fx, ''), 'line')
    WHEN 'grenade_light' THEN 'light-glow'
    WHEN 'flash_effect' THEN 'flash-' || coalesce(nullif(c.fx, ''), nullif(i.fx, ''), 'starburst')
  END AS new_id,
  coalesce(c.color, CASE WHEN i.kind = 'name_glow' THEN i.glow ELSE i.color END) AS colour,
  coalesce(c.color2, i.color2) AS colour2
FROM legacy_x.cosmetic_owned o
JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
LEFT JOIN legacy_x.cosmetic_custom c ON c.user_id = o.user_id AND c.item_id = o.item_id
WHERE i.unlock = 'coin'
  AND i.kind IN ('name_color', 'name_glow', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect')
  AND coalesce(i.fx, '') NOT IN ('rainbow', 'prism', 'spectrum');

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, color2, glow, fx, rarity, enabled) VALUES
  ('name-solid', 'name_color', 'Solid', 'Энгийн', 'coin', 150, '', 1, '#d4d4d4', NULL, NULL, NULL, 1, true),
  ('name-gradient', 'name_color', 'Gradient', 'Градиент', 'coin', 400, '', 2, '#d4d4d4', NULL, NULL, 'gradient', 2, true),
  ('name-fire', 'name_color', 'Fire', 'Гал', 'coin', 500, '', 3, '#d4d4d4', NULL, NULL, 'fire', 3, true),
  ('name-chrome', 'name_color', 'Chrome', 'Хром', 'coin', 500, '', 4, '#d4d4d4', NULL, NULL, 'chrome', 3, true),
  ('name-foil', 'name_color', 'Foil', 'Гялгар', 'coin', 600, '', 5, '#d4d4d4', NULL, NULL, 'foil', 3, true),
  ('name-drift', 'name_color', 'Drift', 'Урсгал', 'coin', 700, '', 6, '#d4d4d4', NULL, NULL, 'drift', 4, true),
  ('glow-halo', 'name_glow', 'Halo', 'Гэрэл цагираг', 'coin', 300, '', 1, NULL, NULL, '#d4d4d4', 'halo', 1, true),
  ('glow-breathe', 'name_glow', 'Breathe', 'Амьсгал', 'coin', 400, '', 2, NULL, NULL, '#d4d4d4', 'breathe', 2, true),
  ('glow-neon', 'name_glow', 'Neon', 'Неон', 'coin', 450, '', 3, NULL, NULL, '#d4d4d4', 'neon', 2, true),
  ('glow-spark', 'name_glow', 'Spark', 'Оч', 'coin', 450, '', 4, NULL, NULL, '#d4d4d4', 'spark', 2, true),
  ('glow-aura', 'name_glow', 'Aura', 'Аура', 'coin', 500, '', 5, NULL, NULL, '#d4d4d4', 'aura', 3, true),
  ('glow-flame', 'name_glow', 'Flame', 'Дөл', 'coin', 500, '', 6, NULL, NULL, '#d4d4d4', 'flame', 3, true),
  ('glow-electric', 'name_glow', 'Electric', 'Цахилгаан', 'coin', 500, '', 7, NULL, NULL, '#d4d4d4', 'electric', 3, true),
  ('glow-pulse', 'name_glow', 'Pulse', 'Цохилт', 'coin', 500, '', 8, NULL, NULL, '#d4d4d4', 'pulse', 3, true),
  ('smoke-solid', 'smoke_color', 'Smoke', 'Утаа', 'coin', 200, '', 1, '#d4d4d4', NULL, NULL, NULL, 1, true),
  ('smoke-dual', 'smoke_color', 'Dual smoke', 'Хос утаа', 'coin', 400, '', 2, '#d4d4d4', '#737373', NULL, 'dual', 3, true),
  ('trail-line', 'grenade_trail', 'Line', 'Шугам', 'coin', 150, '', 1, '#d4d4d4', NULL, NULL, 'line', 1, true),
  ('trail-dash', 'grenade_trail', 'Dash', 'Тасархай', 'coin', 350, '', 2, '#d4d4d4', NULL, NULL, 'dash', 2, true),
  ('trail-double', 'grenade_trail', 'Double', 'Хос', 'coin', 450, '', 3, '#d4d4d4', NULL, NULL, 'double', 3, true),
  ('trail-comet', 'grenade_trail', 'Comet', 'Сүүлт од', 'coin', 500, '', 4, '#d4d4d4', NULL, NULL, 'comet', 3, true),
  ('trail-helix', 'grenade_trail', 'Helix', 'Мушгиа', 'coin', 600, '', 5, '#d4d4d4', NULL, NULL, 'helix', 3, true),
  ('trail-zigzag', 'grenade_trail', 'Zigzag', 'Зигзаг', 'coin', 650, '', 6, '#d4d4d4', NULL, NULL, 'zigzag', 3, true),
  ('trail-flare', 'grenade_trail', 'Flare', 'Бамбар', 'coin', 700, '', 7, '#d4d4d4', NULL, NULL, 'flare', 3, true),
  ('trail-sparks', 'grenade_trail', 'Sparks', 'Оч', 'coin', 750, '', 8, '#d4d4d4', NULL, NULL, 'sparks', 3, true),
  ('trail-starfall', 'grenade_trail', 'Starfall', 'Одот бороо', 'coin', 850, '', 9, '#d4d4d4', NULL, NULL, 'starfall', 4, true),
  ('trail-inferno', 'grenade_trail', 'Inferno', 'Тамын гал', 'coin', 1000, '', 10, '#d4d4d4', NULL, NULL, 'inferno', 4, true),
  ('light-glow', 'grenade_light', 'Light', 'Гэрэл', 'coin', 300, '', 1, '#d4d4d4', NULL, NULL, NULL, 2, true),
  ('flash-starburst', 'flash_effect', 'Starburst', 'Туяа', 'coin', 400, '', 1, '#d4d4d4', NULL, NULL, 'starburst', 2, true),
  ('flash-ring', 'flash_effect', 'Shockwave', 'Долгион', 'coin', 500, '', 2, '#d4d4d4', NULL, NULL, 'ring', 2, true),
  ('flash-nova', 'flash_effect', 'Nova', 'Нова', 'coin', 550, '', 3, '#d4d4d4', NULL, NULL, 'nova', 3, true)
ON CONFLICT (id) DO UPDATE SET name_en = EXCLUDED.name_en, name_mn = EXCLUDED.name_mn, unlock = 'coin', price = EXCLUDED.price, sort = EXCLUDED.sort,
  color = EXCLUDED.color, color2 = EXCLUDED.color2, glow = EXCLUDED.glow, fx = EXCLUDED.fx, rarity = EXCLUDED.rarity, enabled = true;

-- Ownership: the longest of what they had (for good beats any rental).
INSERT INTO legacy_x.cosmetic_owned AS o (user_id, item_id, source, expires_at, acquired_at)
SELECT DISTINCT ON (user_id, new_id) user_id, new_id, source, expires_at, acquired_at FROM colour_moves ORDER BY user_id, new_id, expires_at DESC NULLS FIRST
ON CONFLICT (user_id, item_id) DO UPDATE SET expires_at = CASE WHEN o.expires_at IS NULL OR EXCLUDED.expires_at IS NULL THEN NULL ELSE greatest(o.expires_at, EXCLUDED.expires_at) END;

-- Colours: the variant they wear wins; otherwise the first one owned.
INSERT INTO legacy_x.cosmetic_custom AS c (user_id, item_id, color, color2)
SELECT DISTINCT ON (m.user_id, m.new_id) m.user_id, m.new_id, lower(m.colour), CASE WHEN m.new_id = 'smoke-dual' THEN lower(m.colour2) END
FROM colour_moves m JOIN legacy_x.cosmetic_equipped e ON e.user_id = m.user_id AND e.item_id = m.old_id
WHERE m.colour ~* '^#[0-9a-f]{6}$'
ORDER BY m.user_id, m.new_id
ON CONFLICT (user_id, item_id) DO UPDATE SET color = EXCLUDED.color, color2 = EXCLUDED.color2, updated_at = now();
INSERT INTO legacy_x.cosmetic_custom (user_id, item_id, color, color2)
SELECT DISTINCT ON (user_id, new_id) user_id, new_id, lower(colour), CASE WHEN new_id = 'smoke-dual' THEN lower(colour2) END
FROM colour_moves WHERE colour ~* '^#[0-9a-f]{6}$' ORDER BY user_id, new_id, acquired_at
ON CONFLICT (user_id, item_id) DO NOTHING;

-- What they wear moves to the design.
UPDATE legacy_x.cosmetic_equipped e SET item_id = m.new_id, updated_at = now() FROM colour_moves m WHERE e.user_id = m.user_id AND e.item_id = m.old_id;

-- The colour variants leave the Shop.
UPDATE legacy_x.cosmetic_items SET enabled = false
WHERE unlock IN ('coin', 'free') AND kind IN ('name_color', 'name_glow', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect')
  AND coalesce(fx, '') NOT IN ('rainbow', 'prism', 'spectrum')
  AND id NOT IN ('name-solid', 'name-gradient', 'name-fire', 'name-chrome', 'name-foil', 'name-drift', 'glow-halo', 'glow-breathe', 'glow-neon', 'glow-spark', 'glow-aura', 'glow-flame', 'glow-electric', 'glow-pulse', 'smoke-solid', 'smoke-dual', 'trail-line', 'trail-dash', 'trail-double', 'trail-comet', 'trail-helix', 'trail-zigzag', 'trail-flare', 'trail-sparks', 'trail-starfall', 'trail-inferno', 'light-glow', 'flash-starburst', 'flash-ring', 'flash-nova');
COMMIT;
NOTIFY pgrst, 'reload schema';
