-- Retire unused database objects.
--
-- 1. The LegacyX-Phantom and LegacyX-PlayerTelemetry CS2 plugins were removed (plugins repo
--    da67540), together with every route that used their tables (backend 4a8a152). The
--    LegacyX-Reconnect ingest functions went with the Reconnect plugin.
-- 2. The old website role system (roles, permissions, role_permissions, user_roles), staff_notes
--    and staff_team: no backend or frontend code reads or writes them. Staff authority lives in
--    legacy_x.staff (global) and legacy_x.staff_server_assignments (per game server).
--
-- At the time of writing: the Phantom/Telemetry tables, staff_team and staff_notes held 0 rows;
-- roles 4, role_permissions 104, user_roles 1 (seed data only). Nothing outside these objects
-- referenced them: no views besides the two telemetry views, no policies, no foreign keys in
-- from other tables, and the guard functions below serve only these tables' triggers.
--
-- Kept: staff, staff_server_assignments, users, the Staff Panel tables (staff_sessions,
-- staff_audit_logs, staff_panel_actions, staff_panel_settings), the reconnect tables (read by the
-- Play page, GET /reconnect/me, ranked matches, tournaments) and legacy_x.set_updated_at (shared).
--
-- Irreversible. No CASCADE: if anything new depends on these objects, this stops instead.

BEGIN;

-- Phantom / PlayerTelemetry / Reconnect ingest
DROP VIEW IF EXISTS legacy_x.player_telemetry_profile_summary;
DROP VIEW IF EXISTS legacy_x.player_telemetry_match_latest;

DROP FUNCTION IF EXISTS legacy_x.ingest_player_telemetry_event(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.ingest_phantom_evidence(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.ingest_phantom_suspension_signal(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.ingest_reconnect_event(text, text, text, uuid, text, text, text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS legacy_x.ingest_reconnect_heartbeat(text, text, text, text, text, text, integer);

DROP TABLE IF EXISTS legacy_x.phantom_suspension_events;
DROP TABLE IF EXISTS legacy_x.phantom_suspension_cases;
DROP TABLE IF EXISTS legacy_x.phantom_evidence_events;
DROP TABLE IF EXISTS legacy_x.phantom_history_rounds;
DROP TABLE IF EXISTS legacy_x.player_telemetry_events;

-- Unused role system and staff side tables (their triggers go with the tables)
DROP TABLE IF EXISTS legacy_x.user_roles;
DROP TABLE IF EXISTS legacy_x.role_permissions;
DROP TABLE IF EXISTS legacy_x.permissions;
DROP TABLE IF EXISTS legacy_x.roles;
DROP TABLE IF EXISTS legacy_x.staff_team;
DROP TABLE IF EXISTS legacy_x.staff_notes;

DROP FUNCTION IF EXISTS legacy_x.guard_last_locked_holder();
DROP FUNCTION IF EXISTS legacy_x.guard_locked_roles();
DROP FUNCTION IF EXISTS legacy_x.guard_owner_only_permissions();

COMMIT;

-- Verification: every value must come back NULL / 0.
-- SELECT to_regclass('legacy_x.roles'), to_regclass('legacy_x.user_roles'), to_regclass('legacy_x.staff_team'),
--        to_regclass('legacy_x.phantom_evidence_events'), to_regclass('legacy_x.player_telemetry_events');
-- SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'legacy_x' AND p.proname ~ '(phantom|telemetry|ingest_reconnect|guard_locked|guard_last_locked|guard_owner_only)';
