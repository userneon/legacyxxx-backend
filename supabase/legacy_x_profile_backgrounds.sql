-- Profile backgrounds (owner request 2026-11-02): the React Bits backgrounds as cosmetics. One item each, rented for 30 days only at 10,000 LX (change the
-- price in Staff -> Shop -> Cosmetics), worn behind the whole window on the owner's profile, and every knob of the background is set by its owner
-- (table background_looks, one row per player and background; the website keeps only the knobs a background really has).
-- The ones that have been seen working are switched on; the rest are added switched OFF: check each on a real screen, then turn it on in Staff -> Shop -> Cosmetics.
-- Safe to re-run.

BEGIN;

ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
  ('bg-acid-squares', 'background', 'Acid Squares', 'Acid Squares', 'coin', 10000, '', 100, 3, false, true),
  ('bg-aurora', 'background', 'Aurora', 'Aurora', 'coin', 10000, '', 101, 3, false, true),
  ('bg-balatro', 'background', 'Balatro', 'Balatro', 'coin', 10000, '', 102, 3, false, false),
  ('bg-ballpit', 'background', 'Ballpit', 'Ballpit', 'coin', 10000, '', 103, 3, false, true),
  ('bg-beams', 'background', 'Beams', 'Beams', 'coin', 10000, '', 104, 3, false, false),
  ('bg-c-r-t-warp', 'background', 'C R T Warp', 'C R T Warp', 'coin', 10000, '', 105, 3, false, false),
  ('bg-dark-veil', 'background', 'Dark Veil', 'Dark Veil', 'coin', 10000, '', 106, 3, false, false),
  ('bg-dither', 'background', 'Dither', 'Dither', 'coin', 10000, '', 107, 3, false, true),
  ('bg-dot-field', 'background', 'Dot Field', 'Dot Field', 'coin', 10000, '', 108, 3, false, false),
  ('bg-dot-grid', 'background', 'Dot Grid', 'Dot Grid', 'coin', 10000, '', 109, 3, false, true),
  ('bg-evil-eye', 'background', 'Evil Eye', 'Evil Eye', 'coin', 10000, '', 110, 3, false, false),
  ('bg-faulty-terminal', 'background', 'Faulty Terminal', 'Faulty Terminal', 'coin', 10000, '', 111, 3, false, true),
  ('bg-ferrofluid', 'background', 'Ferrofluid', 'Ferrofluid', 'coin', 10000, '', 112, 3, false, true),
  ('bg-floating-lines', 'background', 'Floating Lines', 'Floating Lines', 'coin', 10000, '', 113, 3, false, true),
  ('bg-flux-lines', 'background', 'Flux Lines', 'Flux Lines', 'coin', 10000, '', 114, 3, false, true),
  ('bg-galaxy', 'background', 'Galaxy', 'Galaxy', 'coin', 10000, '', 115, 3, false, true),
  ('bg-ghost-fibers', 'background', 'Ghost Fibers', 'Ghost Fibers', 'coin', 10000, '', 116, 3, false, true),
  ('bg-gradient-blinds', 'background', 'Gradient Blinds', 'Gradient Blinds', 'coin', 10000, '', 117, 3, false, true),
  ('bg-gradient-waves', 'background', 'Gradient Waves', 'Gradient Waves', 'coin', 10000, '', 118, 3, false, false),
  ('bg-grainient', 'background', 'Grainient', 'Grainient', 'coin', 10000, '', 119, 3, false, true),
  ('bg-grid-distortion', 'background', 'Grid Distortion', 'Grid Distortion', 'coin', 10000, '', 120, 3, false, false),
  ('bg-grid-scan', 'background', 'Grid Scan', 'Grid Scan', 'coin', 10000, '', 121, 3, false, false),
  ('bg-iridescence', 'background', 'Iridescence', 'Iridescence', 'coin', 10000, '', 122, 3, false, true),
  ('bg-letter-glitch', 'background', 'Letter Glitch', 'Letter Glitch', 'coin', 10000, '', 123, 3, false, false),
  ('bg-light-pillar', 'background', 'Light Pillar', 'Light Pillar', 'coin', 10000, '', 124, 3, false, false),
  ('bg-light-rays', 'background', 'Light Rays', 'Light Rays', 'coin', 10000, '', 125, 3, false, false),
  ('bg-light-tunnel', 'background', 'Light Tunnel', 'Light Tunnel', 'coin', 10000, '', 126, 3, false, true),
  ('bg-lightfall', 'background', 'Lightfall', 'Lightfall', 'coin', 10000, '', 127, 3, false, false),
  ('bg-lightning', 'background', 'Lightning', 'Lightning', 'coin', 10000, '', 128, 3, false, true),
  ('bg-liquid-chrome', 'background', 'Liquid Chrome', 'Liquid Chrome', 'coin', 10000, '', 129, 3, false, false),
  ('bg-liquid-ether', 'background', 'Liquid Ether', 'Liquid Ether', 'coin', 10000, '', 130, 3, false, false),
  ('bg-magic-rings', 'background', 'Magic Rings', 'Magic Rings', 'coin', 10000, '', 131, 3, false, false),
  ('bg-magnet-lines', 'background', 'Magnet Lines', 'Magnet Lines', 'coin', 10000, '', 132, 3, false, true),
  ('bg-micro-slats', 'background', 'Micro Slats', 'Micro Slats', 'coin', 10000, '', 133, 3, false, true),
  ('bg-molten-metal', 'background', 'Molten Metal', 'Molten Metal', 'coin', 10000, '', 134, 3, false, false),
  ('bg-orb', 'background', 'Orb', 'Orb', 'coin', 10000, '', 135, 3, false, true),
  ('bg-particles', 'background', 'Particles', 'Particles', 'coin', 10000, '', 136, 3, false, true),
  ('bg-pattern-waves', 'background', 'Pattern Waves', 'Pattern Waves', 'coin', 10000, '', 137, 3, false, true),
  ('bg-pixel-blast', 'background', 'Pixel Blast', 'Pixel Blast', 'coin', 10000, '', 138, 3, false, true),
  ('bg-pixel-snow', 'background', 'Pixel Snow', 'Pixel Snow', 'coin', 10000, '', 139, 3, false, false),
  ('bg-plasma', 'background', 'Plasma', 'Plasma', 'coin', 10000, '', 140, 3, false, false),
  ('bg-plasma-wave', 'background', 'Plasma Wave', 'Plasma Wave', 'coin', 10000, '', 141, 3, false, false),
  ('bg-prism', 'background', 'Prism', 'Prism', 'coin', 10000, '', 142, 3, false, false),
  ('bg-prismatic-burst', 'background', 'Prismatic Burst', 'Prismatic Burst', 'coin', 10000, '', 143, 3, false, false),
  ('bg-radar', 'background', 'Radar', 'Radar', 'coin', 10000, '', 144, 3, false, false),
  ('bg-ripple-grid', 'background', 'Ripple Grid', 'Ripple Grid', 'coin', 10000, '', 145, 3, false, false),
  ('bg-scanner', 'background', 'Scanner', 'Scanner', 'coin', 10000, '', 146, 3, false, true),
  ('bg-shape-grid', 'background', 'Shape Grid', 'Shape Grid', 'coin', 10000, '', 147, 3, false, true),
  ('bg-side-rays', 'background', 'Side Rays', 'Side Rays', 'coin', 10000, '', 148, 3, false, false),
  ('bg-silk', 'background', 'Silk', 'Silk', 'coin', 10000, '', 149, 3, false, false),
  ('bg-sliced-waves', 'background', 'Sliced Waves', 'Sliced Waves', 'coin', 10000, '', 150, 3, false, false),
  ('bg-soft-aurora', 'background', 'Soft Aurora', 'Soft Aurora', 'coin', 10000, '', 151, 3, false, false),
  ('bg-threads', 'background', 'Threads', 'Threads', 'coin', 10000, '', 152, 3, false, true),
  ('bg-topography', 'background', 'Topography', 'Topography', 'coin', 10000, '', 153, 3, false, true),
  ('bg-waves', 'background', 'Waves', 'Waves', 'coin', 10000, '', 154, 3, false, true),
  ('bg-web-threads', 'background', 'Web Threads', 'Web Threads', 'coin', 10000, '', 155, 3, false, false)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS legacy_x.background_looks (
  user_id uuid NOT NULL REFERENCES legacy_x.users (id) ON DELETE CASCADE,
  item_id text NOT NULL,
  look jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
ALTER TABLE legacy_x.background_looks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.background_looks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.background_looks TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
