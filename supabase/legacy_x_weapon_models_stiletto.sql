-- A knife model can also be made for the Stiletto's animations (owner request 2026-11-09: a katana played the Stiletto animation correctly, the M9 one lagged behind).
-- Stiletto is weapon_knife_stiletto, defindex 522. Safe to run again.
ALTER TABLE legacy_x.weapon_models DROP CONSTRAINT IF EXISTS weapon_models_anim_base_check;
ALTER TABLE legacy_x.weapon_models ADD CONSTRAINT weapon_models_anim_base_check
  CHECK (anim_base IS NULL OR anim_base IN ('m9', 'bayonet', 'stiletto', 'default'));
