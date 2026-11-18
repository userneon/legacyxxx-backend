-- New Year avatar frames (owner 2026-11-18): four square frames drawn by the website (frontend src/lib/art-frames.ts), so the website must be deployed first.
-- Added switched OFF: switch each on in Staff -> Shop -> Cosmetics once seen on a real screen. Like every item they sell for 1, 7 or 30 days at the usual shares of the
-- 30-day price. Safe to re-run (a re-run keeps your edits).

BEGIN;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('frame-ny-pine',     'frame', 'Pine & Gold',    'Нарс ба алт',          'coin', 600, '', 30, 3, true,  false),
  ('frame-ny-frost',    'frame', 'Frost',          'Хяруу',                'coin', 600, '', 31, 3, false, false),
  ('frame-ny-santa',    'frame', 'Santa',          'Санта',                'coin', 600, '', 32, 3, false, false),
  ('frame-ny-midnight', 'frame', 'Midnight Gold',  'Шөнө дундын алт',      'coin', 700, '', 33, 4, true,  false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
NOTIFY pgrst, 'reload schema';
