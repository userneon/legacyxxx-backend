-- Only the Root API (service_role) may run the SECURITY DEFINER functions in legacy_x.
--
-- These functions run as their owner (postgres) and were executable by PUBLIC, i.e. by anon and
-- authenticated too (Supabase advisor lints 0028/0029). anon/authenticated have no USAGE on the
-- legacy_x schema, so they could not reach them today; this removes the grant itself so a later
-- schema exposure cannot turn them into public RPC endpoints (ensure_steam_user,
-- save_skinchanger_loadout, rollover_monthly_rank_season, …).
--
-- service_role keeps its explicit EXECUTE grant. notify_penalty_issued is a trigger function;
-- triggers fire regardless of EXECUTE grants. Safe to re-run.

BEGIN;

DO $$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'legacy_x' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;

-- Verification: must return 0.
-- SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'legacy_x' AND p.prosecdef
--    AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute'));
