-- Weapon models sold in the Shop for LX (owner request 2026-11-06): custom models for a knife, the Desert Eagle and the AK-47, rented 1, 7 or 30 days like
-- every other cosmetic. Three new kinds, one worn per kind (a player can wear a knife, a Deagle and an AK model together). The model files themselves are
-- in the Workshop addon (legacyxxx-workshop, compiled/) which every player downloads; this table only says which model paths an item stands for.
--
-- Safe to re-run. Only the Root API (service_role) reads it.

BEGIN;

ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background', 'model_knife', 'model_deagle', 'model_ak47'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background', 'model_knife', 'model_deagle', 'model_ak47'));

CREATE TABLE IF NOT EXISTS legacy_x.weapon_models (
  item_id TEXT PRIMARY KEY REFERENCES legacy_x.cosmetic_items(id) ON DELETE CASCADE,
  -- Which weapon it replaces: the kind of the item says the same (model_knife, model_deagle, model_ak47).
  weapon TEXT NOT NULL CHECK (weapon IN ('knife', 'deagle', 'ak47')),
  -- The model the world sees (dropped, on a player's back and in hand) and the one the owner sees in first person, as the game names them (.vmdl, not .vmdl_c).
  world_model TEXT NOT NULL CHECK (world_model ~ '^[a-z0-9_/.\-]{4,200}\.vmdl$'),
  view_model TEXT NOT NULL CHECK (view_model ~ '^[a-z0-9_/.\-]{4,200}\.vmdl$'),
  -- A knife's first-person animations are the game's own knife's: which one this model was made for (m9 or bayonet). Empty for the other weapons.
  anim_base TEXT CHECK (anim_base IS NULL OR anim_base IN ('m9', 'bayonet')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (weapon = 'knife' OR anim_base IS NULL)
);

ALTER TABLE legacy_x.weapon_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.weapon_models FROM PUBLIC, anon, authenticated;
GRANT ALL ON legacy_x.weapon_models TO service_role;

COMMIT;
