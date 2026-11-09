-- A knife model can also be made for the Karambit's or the Butterfly knife's animations (the Apex Karambit and the Apex Balisong). The Karambit is weapon_knife_karambit
-- (defindex 507), the Butterfly knife (the balisong) weapon_knife_butterfly (defindex 515). Safe to run again.
ALTER TABLE legacy_x.weapon_models DROP CONSTRAINT IF EXISTS weapon_models_anim_base_check;
ALTER TABLE legacy_x.weapon_models ADD CONSTRAINT weapon_models_anim_base_check
  CHECK (anim_base IS NULL OR anim_base IN ('m9', 'bayonet', 'stiletto', 'karambit', 'butterfly', 'default'));
