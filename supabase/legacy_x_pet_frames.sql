-- Pet and Plush avatar frames (owner 2026-11-20): eight Pets and four Plush winter frames, drawn by the website (frontend src/lib/art-frames.ts), so the website must be deployed first.
-- Added switched OFF: switch each on in Staff -> Shop -> Cosmetics once seen on a real screen. Like every item they sell for 1, 7 or 30 days at the usual shares of the
-- 30-day price. Safe to re-run (a re-run keeps your edits). (The Discord frame, frame-discord, is not a shop item: its use is still to be decided.)

BEGIN;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('frame-pet-cat',        'frame', 'Cat',            'Муур',               'coin', 500, '', 40, 2, false, false),
  ('frame-pet-dog',        'frame', 'Dog',            'Нохой',              'coin', 500, '', 41, 2, false, false),
  ('frame-pet-bunny',      'frame', 'Bunny',          'Туулай',             'coin', 500, '', 42, 2, false, false),
  ('frame-pet-panda',      'frame', 'Panda',          'Панда',              'coin', 500, '', 43, 2, false, false),
  ('frame-pet-bear',       'frame', 'Bear',           'Баавгай',            'coin', 500, '', 44, 2, false, false),
  ('frame-pet-fox',        'frame', 'Fox',            'Үнэг',               'coin', 500, '', 45, 2, false, false),
  ('frame-pet-penguin',    'frame', 'Penguin',        'Оцон шувуу',         'coin', 500, '', 46, 2, false, false),
  ('frame-pet-reindeer',   'frame', 'Reindeer',       'Цаа буга',           'coin', 500, '', 47, 2, false, false),
  ('frame-plush-cat',      'frame', 'Plush Cat',      'Үслэг муур',         'coin', 700, '', 50, 3, true,  false),
  ('frame-plush-penguin',  'frame', 'Plush Penguin',  'Үслэг оцон шувуу',   'coin', 700, '', 51, 3, false, false),
  ('frame-plush-bear',     'frame', 'Plush Bear',     'Үслэг баавгай',      'coin', 700, '', 52, 3, false, false),
  ('frame-plush-bunny',    'frame', 'Plush Bunny',    'Үслэг туулай',       'coin', 700, '', 53, 3, false, false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
NOTIFY pgrst, 'reload schema';
