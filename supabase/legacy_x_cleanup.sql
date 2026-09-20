-- Database cleanup, 2026-09-20.
--
-- An audit compared every table, view and function in legacy_x against the Root API, AdminPlus and
-- the CS2 plugins. Exactly one object was reachable from nothing at all; everything else that looked
-- unused from the API is written or read by an ingest function, so it stays.
--
-- Run the statements you want; each one is independent.

/* ---------------------------------------------------------------------------
 * 1. Leftover migration backup (0 rows, referenced by no code, view or function)
 * ------------------------------------------------------------------------ */

DROP TABLE IF EXISTS legacy_x.users_staff_fields_backup_20260826;

/* ---------------------------------------------------------------------------
 * 2. Session hygiene
 *
 * legacy_x.user_sessions holds 811 rows for 7 players: every refresh writes a row and nothing ever
 * removes one. Expired rows carry a refresh-token hash, so keeping them is a liability as well as
 * clutter. This deletes what has already expired; schedule it (pg_cron, or the API on boot) so it
 * keeps holding.
 * ------------------------------------------------------------------------ */

DELETE FROM legacy_x.user_sessions
WHERE expires_at < now() - interval '7 days';

-- Optional, if pg_cron is enabled on the project:
-- SELECT cron.schedule('legacyx-prune-sessions', '0 4 * * *',
--   $$DELETE FROM legacy_x.user_sessions WHERE expires_at < now() - interval '7 days'$$);

/* ---------------------------------------------------------------------------
 * 3. Verification
 * ------------------------------------------------------------------------ */

-- SELECT count(*) AS sessions_left FROM legacy_x.user_sessions;
-- SELECT to_regclass('legacy_x.users_staff_fields_backup_20260826') AS should_be_null;
