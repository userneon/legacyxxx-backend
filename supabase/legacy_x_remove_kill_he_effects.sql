-- Kill effects and HE explosion effects are taken out (owner request 2026-10-26). What players paid for them was given back first
-- (refunds with refs `refund:kill-he-removed:<spend ref>`, run once on 2026-10-26), then the items and everything pointing at them go.
-- Safe to re-run.
DELETE FROM legacy_x.cosmetic_equipped WHERE kind IN ('kill_effect', 'he_effect');
DELETE FROM legacy_x.cosmetic_items WHERE kind IN ('kill_effect', 'he_effect');
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow', 'emote', 'banner', 'title', 'smoke_color', 'grenade_trail', 'grenade_light', 'flash_effect'));
NOTIFY pgrst, 'reload schema';
