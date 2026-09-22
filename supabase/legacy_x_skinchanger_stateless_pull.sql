-- Skinchanger: from a queue to a stateless pull.
--
-- Before: the website queued an apply job, the plugin tracked server sessions, claimed jobs,
-- applied them and acknowledged each one. After: the plugin reads the player's saved loadout on
-- demand (GET /plugin/skinchanger/loadout, when the player types !rs). Nothing is queued and no
-- session is tracked, so the queue, the session table and the plugin receipts go.
--
-- Kept untouched: skinchanger_catalog_items, skinchanger_loadouts, skinchanger_loadout_entries and
-- the catalog / loadout functions.
--
-- At the time of writing all three dropped tables held 0 rows, nothing else referenced them (their
-- only foreign keys point out to legacy_x.users), and only the four functions below touched them.
--
-- Irreversible. Apply only after the backend without the queue routes is deployed, and after the
-- SkinBridge plugin has moved to the pull route — the current plugin still calls the session and job
-- endpoints.

BEGIN;

/* ---------------------------------------------------------------------------
 * Functions first: they depend on the tables.
 * ------------------------------------------------------------------------ */

DROP FUNCTION IF EXISTS legacy_x.queue_skinchanger_apply(uuid, text);
DROP FUNCTION IF EXISTS legacy_x.claim_skinchanger_apply_jobs(text, integer);
DROP FUNCTION IF EXISTS legacy_x.ack_skinchanger_apply(uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS legacy_x.ingest_skinchanger_session(text, text, text, text, text, text);

-- Any overload the signatures above missed.
DO $$
DECLARE fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'legacy_x'
      AND p.proname IN ('queue_skinchanger_apply', 'claim_skinchanger_apply_jobs', 'ack_skinchanger_apply', 'ingest_skinchanger_session')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', fn.signature);
  END LOOP;
END $$;

/* ---------------------------------------------------------------------------
 * Tables (no CASCADE: if anything still depends on them, stop instead)
 * ------------------------------------------------------------------------ */

DROP TABLE IF EXISTS legacy_x.skinchanger_apply_jobs;
DROP TABLE IF EXISTS legacy_x.skinchanger_server_sessions;
DROP TABLE IF EXISTS legacy_x.skinchanger_plugin_receipts;

COMMIT;

-- Verification: every value must come back NULL / 0.
-- SELECT to_regclass('legacy_x.skinchanger_apply_jobs'), to_regclass('legacy_x.skinchanger_server_sessions'),
--        to_regclass('legacy_x.skinchanger_plugin_receipts');
-- SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'legacy_x'
--    AND p.proname IN ('queue_skinchanger_apply', 'claim_skinchanger_apply_jobs', 'ack_skinchanger_apply', 'ingest_skinchanger_session');
