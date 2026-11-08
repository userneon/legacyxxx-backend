-- Agent models sold in the Shop for LX (owner request 2026-11-08, LegacyReplace.zip: 80 agent models): a player model for the CT side and one for the T side,
-- rented 1, 7 or 30 days like every other cosmetic. Two new kinds, one worn per kind (a player can wear a CT agent and a T agent together).
-- The table of the weapon models is reused: the item's `weapon` is agent_ct or agent_t and its world_model is the agent's model (view_model repeats it, the
-- column is required). The model files are in the Workshop addon (legacyxxx-workshop, compiled/agents/) which every player downloads.
--
-- Safe to re-run. Only the Root API (service_role) reads it. Items are added by scripts/make-agent-models-sql.mjs, all switched OFF.

BEGIN;

ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background', 'model_knife', 'model_deagle', 'model_ak47', 'model_agent_ct', 'model_agent_t'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect', 'background', 'model_knife', 'model_deagle', 'model_ak47', 'model_agent_ct', 'model_agent_t'));
ALTER TABLE legacy_x.weapon_models DROP CONSTRAINT IF EXISTS weapon_models_weapon_check;
ALTER TABLE legacy_x.weapon_models ADD CONSTRAINT weapon_models_weapon_check CHECK (weapon IN ('knife', 'deagle', 'ak47', 'agent_ct', 'agent_t'));

COMMIT;
