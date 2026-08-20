BEGIN;

REVOKE ALL ON FUNCTION legacy_x.core_match_active_slots_ready(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.remove_core_match_fill(TEXT, TEXT, UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.core_match_slot_fill_reward_policy() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION legacy_x.core_match_active_slots_ready(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.remove_core_match_fill(TEXT, TEXT, UUID, INTEGER, TEXT) TO service_role;

COMMIT;
