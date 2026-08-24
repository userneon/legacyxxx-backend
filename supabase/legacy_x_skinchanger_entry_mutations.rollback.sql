-- Rollback only after reverting the Root API commit that calls these functions.
BEGIN;
REVOKE ALL ON FUNCTION legacy_x.upsert_skinchanger_loadout_entry(UUID, BIGINT, JSONB) FROM service_role;
REVOKE ALL ON FUNCTION legacy_x.delete_skinchanger_loadout_entry(UUID, BIGINT, TEXT, TEXT) FROM service_role;
DROP FUNCTION IF EXISTS legacy_x.upsert_skinchanger_loadout_entry(UUID, BIGINT, JSONB);
DROP FUNCTION IF EXISTS legacy_x.delete_skinchanger_loadout_entry(UUID, BIGINT, TEXT, TEXT);
COMMIT;
