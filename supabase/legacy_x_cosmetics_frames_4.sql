-- Thirty-eight more avatar frames (owner request 2026-10-30, two art sheets). Art is public/frames/<id>.webp on the website, so they are added
-- switched OFF: deploy the website first, then turn them on with
--   UPDATE legacy_x.cosmetic_items SET enabled = true WHERE kind = 'frame' AND (id LIKE 'rank-%' OR id LIKE 'frog-%');
-- 1) Eighteen rank frames, one per rank (rank-1 Recruit I ... rank-18 Legacy): EARNED, never sold. A player gets the frame of every rank they
--    reach (the trigger below, on competitive_player_progression) and keeps it when they fall back; players already ranked get their current rank's.
-- 2) Twenty frog frames at 1,000 LX for 30 days (3,000 LX forever), like the painted frames. Safe to re-run.
BEGIN;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('rank-1', 'frame', 'Recruit I', 'Recruit I', 'achievement', 0, 'Reach Recruit I', 100, 1, false, false),
  ('rank-2', 'frame', 'Recruit II', 'Recruit II', 'achievement', 0, 'Reach Recruit II', 101, 1, false, false),
  ('rank-3', 'frame', 'Recruit III', 'Recruit III', 'achievement', 0, 'Reach Recruit III', 102, 1, false, false),
  ('rank-4', 'frame', 'Recruit IV', 'Recruit IV', 'achievement', 0, 'Reach Recruit IV', 103, 1, false, false),
  ('rank-5', 'frame', 'Recruit V', 'Recruit V', 'achievement', 0, 'Reach Recruit V', 104, 1, false, false),
  ('rank-6', 'frame', 'Recruit VI', 'Recruit VI', 'achievement', 0, 'Reach Recruit VI', 105, 1, false, false),
  ('rank-7', 'frame', 'Operator I', 'Operator I', 'achievement', 0, 'Reach Operator I', 106, 2, false, false),
  ('rank-8', 'frame', 'Operator II', 'Operator II', 'achievement', 0, 'Reach Operator II', 107, 2, false, false),
  ('rank-9', 'frame', 'Operator III', 'Operator III', 'achievement', 0, 'Reach Operator III', 108, 2, false, false),
  ('rank-10', 'frame', 'Operator IV', 'Operator IV', 'achievement', 0, 'Reach Operator IV', 109, 2, false, false),
  ('rank-11', 'frame', 'Vanguard I', 'Vanguard I', 'achievement', 0, 'Reach Vanguard I', 110, 3, false, false),
  ('rank-12', 'frame', 'Vanguard II', 'Vanguard II', 'achievement', 0, 'Reach Vanguard II', 111, 3, false, false),
  ('rank-13', 'frame', 'Vanguard III', 'Vanguard III', 'achievement', 0, 'Reach Vanguard III', 112, 3, false, false),
  ('rank-14', 'frame', 'Vanguard IV', 'Vanguard IV', 'achievement', 0, 'Reach Vanguard IV', 113, 3, false, false),
  ('rank-15', 'frame', 'Ace I', 'Ace I', 'achievement', 0, 'Reach Ace I', 114, 4, false, false),
  ('rank-16', 'frame', 'Ace II', 'Ace II', 'achievement', 0, 'Reach Ace II', 115, 4, false, false),
  ('rank-17', 'frame', 'Apex', 'Apex', 'achievement', 0, 'Reach Apex', 116, 4, false, false),
  ('rank-18', 'frame', 'Legacy', 'Legacy', 'achievement', 0, 'Reach Legacy', 117, 4, false, false),
  ('frog-jungle', 'frame', 'Jungle Frog', 'Ширэнгэн мэлхий', 'coin', 1000, '', 70, 3, false, false),
  ('frog-boss', 'frame', 'Boss Frog', 'Босс мэлхий', 'coin', 1000, '', 71, 3, false, false),
  ('frog-tears', 'frame', 'Tears Frog', 'Нулимс мэлхий', 'coin', 1000, '', 72, 3, false, false),
  ('frog-hearts', 'frame', 'Hearts Frog', 'Хайрын мэлхий', 'coin', 1000, '', 73, 3, false, false),
  ('frog-wizard', 'frame', 'Wizard Frog', 'Шидтэн мэлхий', 'coin', 1000, '', 74, 3, false, false),
  ('frog-gamer', 'frame', 'Gamer Frog', 'Тоглогч мэлхий', 'coin', 1000, '', 75, 3, false, false),
  ('frog-rage', 'frame', 'Rage Frog', 'Уур мэлхий', 'coin', 1000, '', 76, 3, false, false),
  ('frog-storm', 'frame', 'Storm Frog', 'Шуурга мэлхий', 'coin', 1000, '', 77, 3, false, false),
  ('frog-money', 'frame', 'Money Frog', 'Мөнгөн мэлхий', 'coin', 1000, '', 78, 3, false, false),
  ('frog-hood', 'frame', 'Hood Frog', 'Нөмрөгтэй мэлхий', 'coin', 1000, '', 79, 3, false, false),
  ('frog-sleepy', 'frame', 'Sleepy Frog', 'Нойрмог мэлхий', 'coin', 1000, '', 80, 3, false, false),
  ('frog-angel', 'frame', 'Angel Frog', 'Сахиусан мэлхий', 'coin', 1000, '', 81, 3, false, false),
  ('frog-devil', 'frame', 'Devil Frog', 'Чөтгөр мэлхий', 'coin', 1000, '', 82, 3, false, false),
  ('frog-explorer', 'frame', 'Explorer Frog', 'Судлаач мэлхий', 'coin', 1000, '', 83, 3, false, false),
  ('frog-sakura', 'frame', 'Sakura Frog', 'Сакура мэлхий', 'coin', 1000, '', 84, 3, false, false),
  ('frog-samurai', 'frame', 'Samurai Frog', 'Самурай мэлхий', 'coin', 1000, '', 85, 3, false, false),
  ('frog-astronaut', 'frame', 'Astronaut Frog', 'Сансрын мэлхий', 'coin', 1000, '', 86, 3, false, false),
  ('frog-christmas', 'frame', 'Christmas Frog', 'Зул сарын мэлхий', 'coin', 1000, '', 87, 3, false, false),
  ('frog-pumpkin', 'frame', 'Pumpkin Frog', 'Хулуу мэлхий', 'coin', 1000, '', 88, 3, false, false),
  ('frog-glitch', 'frame', 'Glitch Frog', 'Глитч мэлхий', 'coin', 1000, '', 89, 3, false, false)
ON CONFLICT (id) DO NOTHING;

-- A player gets the frame of every rank they reach: on a new progression row the frame of their rank, and on a rise every rank passed.
CREATE OR REPLACE FUNCTION legacy_x.grant_rank_frames() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = legacy_x, public AS $$
DECLARE v_from integer;
BEGIN
  IF NEW.current_rank_id IS NULL THEN RETURN NEW; END IF;
  v_from := CASE WHEN TG_OP = 'UPDATE' AND OLD.current_rank_id IS NOT NULL THEN OLD.current_rank_id + 1 ELSE NEW.current_rank_id END;
  IF v_from > NEW.current_rank_id THEN RETURN NEW; END IF;
  INSERT INTO legacy_x.cosmetic_owned (user_id, item_id, source)
  SELECT NEW.user_id, 'rank-' || g, 'achievement' FROM generate_series(GREATEST(v_from, 1), LEAST(NEW.current_rank_id, 18)) AS g
  ON CONFLICT (user_id, item_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION legacy_x.grant_rank_frames() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER competitive_progression_rank_frames AFTER INSERT OR UPDATE OF current_rank_id ON legacy_x.competitive_player_progression
  FOR EACH ROW EXECUTE FUNCTION legacy_x.grant_rank_frames();

-- Players ranked already: the frame of their rank now.
INSERT INTO legacy_x.cosmetic_owned (user_id, item_id, source)
SELECT user_id, 'rank-' || current_rank_id, 'achievement' FROM legacy_x.competitive_player_progression WHERE current_rank_id BETWEEN 1 AND 18
ON CONFLICT (user_id, item_id) DO NOTHING;

COMMIT;
NOTIFY pgrst, 'reload schema';
