-- Frames: no free frames, and the cheapest frame bought with LX costs 500 (owner's decision, 2026-10-10). Safe to re-run.
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE kind = 'frame' AND unlock = 'free';
UPDATE legacy_x.cosmetic_items SET price = 500 WHERE kind = 'frame' AND unlock = 'coin' AND price < 500;
