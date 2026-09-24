REVOKE ALL ON FUNCTION legacy_x.competitive_metric(JSONB, TEXT, INTEGER), legacy_x.competitive_rank_for_exp(INTEGER), legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB), legacy_x.core_match_active_slots_ready(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.competitive_metric(JSONB, TEXT, INTEGER), legacy_x.competitive_rank_for_exp(INTEGER), legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB), legacy_x.core_match_active_slots_ready(UUID) TO service_role;
