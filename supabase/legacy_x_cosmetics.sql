-- Cosmetics (avatar frames first). Purely visual: nothing here changes gameplay, EXP or ranks.
-- Unlock: free (everyone), coin (bought once with wallet coins), achievement (granted by staff/automation, never sold).
-- Only the API (service_role) touches these tables. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_items (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  kind text NOT NULL CHECK (kind IN ('frame')),
  name_en text NOT NULL CHECK (char_length(name_en) BETWEEN 2 AND 40),
  name_mn text NOT NULL CHECK (char_length(name_mn) BETWEEN 2 AND 40),
  unlock text NOT NULL CHECK (unlock IN ('free', 'coin', 'achievement')),
  price integer NOT NULL DEFAULT 0 CHECK (price >= 0 AND (unlock = 'coin') = (price > 0)),
  requirement text NOT NULL DEFAULT '' CHECK (char_length(requirement) <= 80),
  sort integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_owned (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES legacy_x.cosmetic_items(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('coin', 'achievement', 'staff')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_equipped (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('frame')),
  item_id text NOT NULL REFERENCES legacy_x.cosmetic_items(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

ALTER TABLE legacy_x.cosmetic_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.cosmetic_owned ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.cosmetic_equipped ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.cosmetic_items, legacy_x.cosmetic_owned, legacy_x.cosmetic_equipped FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.cosmetic_items, legacy_x.cosmetic_owned, legacy_x.cosmetic_equipped TO service_role;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort) VALUES
  ('red-dragon', 'frame', 'Red Dragon', 'Улаан луу', 'free', 0, '', 1),
  ('crimson-thorns', 'frame', 'Crimson Thorns', 'Цусан өргөс', 'free', 0, '', 2),
  ('shattered-glass', 'frame', 'Shattered Glass', 'Хагарсан шил', 'free', 0, '', 3),
  ('frost-ring', 'frame', 'Frost Ring', 'Мөсөн цагираг', 'coin', 200, '', 4),
  ('white-lily', 'frame', 'White Lily', 'Цагаан сараана', 'coin', 200, '', 5),
  ('inferno', 'frame', 'Inferno', 'Галт цагираг', 'coin', 250, '', 6),
  ('blood-moon', 'frame', 'Blood Moon', 'Цус сар', 'coin', 300, '', 7),
  ('violet-moon', 'frame', 'Violet Moon', 'Нил сар', 'coin', 300, '', 8),
  ('sakura-silk', 'frame', 'Sakura Silk', 'Сакура торго', 'coin', 300, '', 9),
  ('cyber-violet', 'frame', 'Cyber Violet', 'Кибер нил', 'coin', 350, '', 10),
  ('oni-samurai', 'frame', 'Oni Samurai', 'Они ба сакура', 'coin', 450, '', 11),
  ('emerald-dragon', 'frame', 'Emerald Dragon', 'Ногоон луу', 'coin', 450, '', 12),
  ('golden-crown', 'frame', 'Golden Crown', 'Алтан титэм', 'achievement', 0, 'Reach the Legacy rank', 13),
  ('raven-wing', 'frame', 'Raven Wing', 'Хэрээний жигүүр', 'achievement', 0, 'Reach the Apex rank', 14),
  ('ghost-skull', 'frame', 'Ghost Skull', 'Мөсөн гавлын яс', 'achievement', 0, 'Season 1 winner', 15),
  ('eclipse', 'frame', 'Eclipse', 'Хиртэлт', 'achievement', 0, 'Clan tournament winner', 16)
ON CONFLICT (id) DO NOTHING;
