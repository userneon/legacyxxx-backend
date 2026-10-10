-- Frames: no free frames, and the cheapest frame bought with LX costs 500 (owner's decision, 2026-10-10). Safe to re-run.
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE kind = 'frame' AND unlock = 'free';
UPDATE legacy_x.cosmetic_items SET price = 500 WHERE kind = 'frame' AND unlock = 'coin' AND price < 500;

-- The same for name colours and glows: nothing is free, and nothing bought with LX costs less than 500. Safe to re-run.
UPDATE legacy_x.cosmetic_items SET price = 500 WHERE unlock = 'coin' AND price < 500 AND kind IN ('name_color', 'name_glow');
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE unlock = 'free';
