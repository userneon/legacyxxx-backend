-- Colours (and shapes) picked by hand for the in-game cosmetics (owner request 2026-10-25), like Custom colour for names: about 50% above
-- the dearest plain item of the kind. Custom trail and Custom kill effect also keep the shape the player picks (cosmetic_custom.fx);
-- the API checks it against the shapes the game server knows. Safe to re-run.
ALTER TABLE legacy_x.cosmetic_custom ADD COLUMN IF NOT EXISTS fx text CHECK (fx IS NULL OR fx ~ '^[a-z]{2,16}$');

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, fx, rarity) VALUES
  ('smoke-custom', 'smoke_color', 'Custom smoke', 'Өөрийн утаа', 'coin', 375, '', 90, '#8b5cf6', NULL, 3),
  ('trail-custom', 'grenade_trail', 'Custom trail', 'Өөрийн мөр', 'coin', 900, '', 90, '#8b5cf6', 'line', 4),
  ('light-custom', 'grenade_light', 'Custom light', 'Өөрийн гэрэл', 'coin', 600, '', 90, '#8b5cf6', NULL, 3),
  ('kill-custom', 'kill_effect', 'Custom kill effect', 'Өөрийн kill эффект', 'coin', 1200, '', 90, '#8b5cf6', 'ring', 4)
ON CONFLICT (id) DO NOTHING;
NOTIFY pgrst, 'reload schema';
