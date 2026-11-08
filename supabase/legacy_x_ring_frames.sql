-- Ring frames (owner request 2026-11-08): eight light CSS rings round the round avatar, four colour wheels ("ring-*") and four running beams ("beam-*").
-- Drawn by the website (frontend src/lib/ring-frames.ts), so the website must be deployed first. Added switched OFF: switch each on in Staff -> Shop -> Cosmetics
-- once seen on a real screen. Like every item they sell for 1, 7 or 30 days at the usual shares of the 30-day price. Safe to re-run (a re-run keeps your edits).

BEGIN;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('ring-aurora',  'frame', 'Aurora Ring',  'Туяат цагираг',     'coin', 1200, '', 10, 3, false, false),
  ('ring-ember',   'frame', 'Ember Ring',   'Галт цагираг',      'coin', 1200, '', 11, 3, false, false),
  ('ring-frost',   'frame', 'Frost Ring',   'Мөсөн цагираг',     'coin', 1200, '', 12, 3, false, false),
  ('ring-jade',    'frame', 'Jade Ring',    'Хаш цагираг',       'coin', 1200, '', 13, 3, false, false),
  ('beam-white',   'frame', 'White Beam',   'Цагаан туяа',       'coin', 1000, '', 20, 2, false, false),
  ('beam-violet',  'frame', 'Violet Beam',  'Нил ягаан туяа',    'coin', 1000, '', 21, 2, false, false),
  ('beam-crimson', 'frame', 'Crimson Beam', 'Час улаан туяа',    'coin', 1000, '', 22, 2, false, false),
  ('beam-gold',    'frame', 'Gold Beam',    'Алтан туяа',        'coin', 1000, '', 23, 2, false, false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
NOTIFY pgrst, 'reload schema';
