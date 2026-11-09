-- A knife model can be made for the animations of any of these knives (owner request 2026-11-09: the katanas play right on the Paracord knife). Each name is the knife
-- that sits under the model: see ANIMATION_KNIVES in server/legacyX/routes.ts and AnimKnives in the plugin. Safe to run again.
ALTER TABLE legacy_x.weapon_models DROP CONSTRAINT IF EXISTS weapon_models_anim_base_check;
ALTER TABLE legacy_x.weapon_models ADD CONSTRAINT weapon_models_anim_base_check
  CHECK (anim_base IS NULL OR anim_base IN ('m9', 'bayonet', 'classic', 'flip', 'gut', 'karambit', 'huntsman', 'falchion', 'bowie', 'butterfly', 'daggers', 'paracord', 'survival', 'ursus', 'navaja', 'nomad', 'stiletto', 'talon', 'skeleton', 'default'));
