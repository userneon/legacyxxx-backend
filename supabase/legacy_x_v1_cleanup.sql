-- Legacy-X v1 cleanup: one ranking source of truth (competitive EXP), no clans, no seasonal rank, no dead match tables.
--
-- Every object dropped here was checked against the frontend, the root API, AdminPlus, the CS2 plugins, SQL
-- functions/views and the deploy config (see docs/V1_CLEANUP_AUDIT.md). All of them hold 0 rows except
-- rank_seasons (the single "season-1" definition that only the seasonal rank used).
--
-- Deploy order: ship the API that no longer reads these objects FIRST, then run this file once.
BEGIN;

-- 1. Match Core no longer needs an active rank season to create a match, and match_created inserts the match
--    before its event row (the previous order violated core_match_events_match_id_fkey on every new match).
CREATE OR REPLACE FUNCTION legacy_x.ingest_core_match_event(p_plugin_id text, p_event_id text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'legacy_x', 'public'
AS $function$
DECLARE
  v_type TEXT := COALESCE(p_payload->>'event_type', '');
  v_match_id UUID;
  v_match legacy_x.core_matches%ROWTYPE;
  v_team JSONB;
  v_player JSONB;
  v_user_id UUID;
  v_steam_id TEXT;
  v_team_key TEXT;
  v_slot INTEGER;
  v_expected INTEGER;
  v_new_state TEXT;
  v_participant legacy_x.core_match_participants%ROWTYPE;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN
    RAISE EXCEPTION 'Unsupported Match Core plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event_id', '') <> p_event_id THEN
    RAISE EXCEPTION 'event_id mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_type = 'match_created' THEN
    v_match_id := (p_payload->>'match_id')::UUID;
    IF jsonb_array_length(COALESCE(p_payload->'participants', '[]'::jsonb)) <> 10 THEN
      RAISE EXCEPTION 'match_created requires exactly 10 original participants' USING ERRCODE = '22023';
    END IF;
    -- The match row must exist before its first event row (core_match_events.match_id references it).
    INSERT INTO legacy_x.core_matches (id, server_id, matchzy_local_id, state, map_name, map_number)
    VALUES (v_match_id,
            p_payload->>'server_id',
            NULLIF(p_payload->>'matchzy_local_id', ''),
            'WAITING',
            p_payload->>'map_name',
            COALESCE((p_payload->>'map_number')::INTEGER, 0))
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, payload)
    VALUES (p_event_id, v_match_id, v_type, p_payload)
    ON CONFLICT (event_id) DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'event_id % was already used for another match', p_event_id USING ERRCODE = '22023';
    END IF;

    FOR v_player IN SELECT value FROM jsonb_array_elements(p_payload->'participants') LOOP
      v_steam_id := v_player->>'steam_id';
      v_team_key := v_player->>'team_key';
      v_slot := (v_player->>'slot_index')::INTEGER;
      IF v_steam_id !~ '^\d{15,20}$' OR v_team_key NOT IN ('team1', 'team2') OR v_slot NOT BETWEEN 1 AND 5 THEN
        RAISE EXCEPTION 'invalid original participant' USING ERRCODE = '22023';
      END IF;
      INSERT INTO legacy_x.users (steam_id, username, avatar)
      VALUES (v_steam_id, COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id), '')
      ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username
      RETURNING id INTO v_user_id;
      INSERT INTO legacy_x.core_match_participants (match_id, user_id, steam_id, team_key, slot_index, original_name)
      VALUES (v_match_id, v_user_id, v_steam_id, v_team_key, v_slot, COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id));
      INSERT INTO legacy_x.core_match_slots (match_id, team_key, slot_index, original_user_id, active_user_id, active_role)
      VALUES (v_match_id, v_team_key, v_slot, v_user_id, v_user_id, 'original');
    END LOOP;
    RETURN jsonb_build_object('status', 'created', 'match_id', v_match_id, 'state', 'WAITING', 'revision', 1);
  END IF;

  v_match_id := (p_payload->>'match_id')::UUID;
  SELECT * INTO v_match FROM legacy_x.core_matches WHERE id = v_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown match_id' USING ERRCODE = '22023'; END IF;
  v_expected := COALESCE((p_payload->>'expected_revision')::INTEGER, -1);
  IF v_expected <> v_match.revision THEN
    RETURN jsonb_build_object('status', 'stale', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision);
  END IF;

  INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, expected_revision, payload)
  VALUES (p_event_id, v_match_id, v_type, v_expected, p_payload)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision);
  END IF;

  IF v_type = 'state_transition' THEN
    v_new_state := p_payload->>'state';
    IF (v_match.state = 'WAITING' AND v_new_state = 'LIVE') OR
       (v_match.state = 'LIVE' AND v_new_state = 'PAUSED') OR
       (v_match.state = 'PAUSED' AND v_new_state = 'LIVE') OR
       (v_match.state IN ('LIVE', 'PAUSED') AND v_new_state IN ('FINISHED', 'CANCELLED')) THEN
      IF v_new_state = 'LIVE' AND NOT legacy_x.core_match_active_slots_ready(v_match_id) THEN
        RAISE EXCEPTION 'cannot resume without exactly ten active slots' USING ERRCODE = '22023';
      END IF;
      UPDATE legacy_x.core_matches SET
        state = v_new_state,
        revision = revision + 1,
        pause_reason = CASE WHEN v_new_state = 'PAUSED' THEN COALESCE(p_payload->>'reason', 'unspecified') ELSE NULL END,
        paused_at = CASE WHEN v_new_state = 'PAUSED' THEN now() ELSE paused_at END,
        started_at = CASE WHEN v_new_state = 'LIVE' AND started_at IS NULL THEN now() ELSE started_at END,
        finished_at = CASE WHEN v_new_state = 'FINISHED' THEN now() ELSE finished_at END,
        cancelled_at = CASE WHEN v_new_state = 'CANCELLED' THEN now() ELSE cancelled_at END,
        updated_at = now()
      WHERE id = v_match_id
      RETURNING * INTO v_match;
    ELSE
      RAISE EXCEPTION 'invalid state transition % -> %', v_match.state, v_new_state USING ERRCODE = '22023';
    END IF;
  ELSIF v_type IN ('player_disconnected', 'player_returned') THEN
    v_steam_id := p_payload->>'steam_id';
    SELECT * INTO v_participant FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND steam_id = v_steam_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'player is not an original participant' USING ERRCODE = '22023'; END IF;
    IF v_type = 'player_disconnected' THEN
      UPDATE legacy_x.core_match_participants SET connected = false, disconnected_at = now(), reconnect_deadline = now() + make_interval(secs => COALESCE((p_payload->>'reconnect_window_seconds')::INTEGER, 300)), updated_at = now()
      WHERE match_id = v_match_id AND user_id = v_participant.user_id;
      UPDATE legacy_x.core_match_slots SET active_user_id = NULL, active_role = NULL, updated_at = now()
      WHERE match_id = v_match_id AND original_user_id = v_participant.user_id;
      IF v_match.state = 'LIVE' THEN
        UPDATE legacy_x.core_matches SET state = 'PAUSED', pause_reason = 'original_participant_disconnected', paused_at = now(), revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
      ELSE
        UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
      END IF;
    ELSE
      IF v_participant.reconnect_deadline IS NOT NULL AND v_participant.reconnect_deadline < now() THEN RAISE EXCEPTION 'reconnect window expired' USING ERRCODE = '22023'; END IF;
      UPDATE legacy_x.core_match_participants SET connected = true, returned_at = now(), updated_at = now() WHERE match_id = v_match_id AND user_id = v_participant.user_id;
      UPDATE legacy_x.core_match_slots SET active_user_id = v_participant.user_id, active_role = 'original', fill_user_id = NULL, updated_at = now() WHERE match_id = v_match_id AND original_user_id = v_participant.user_id;
      UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
    END IF;
  ELSIF v_type = 'fill_assigned' THEN
    v_team_key := p_payload->>'team_key'; v_slot := (p_payload->>'slot_index')::INTEGER; v_steam_id := p_payload->>'steam_id';
    INSERT INTO legacy_x.users (steam_id, username, avatar) VALUES (v_steam_id, COALESCE(NULLIF(p_payload->>'name', ''), 'Steam ' || v_steam_id), '') ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username RETURNING id INTO v_user_id;
    UPDATE legacy_x.core_match_slots SET active_user_id = v_user_id, active_role = 'fill', fill_user_id = v_user_id, updated_at = now()
    WHERE match_id = v_match_id AND team_key = v_team_key AND slot_index = v_slot AND active_user_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'requested fill slot is not empty' USING ERRCODE = '22023'; END IF;
    UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'snapshot_saved' THEN
    v_steam_id := p_payload->>'steam_id';
    SELECT user_id INTO v_user_id FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND steam_id = v_steam_id;
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'snapshot player is not an original participant' USING ERRCODE = '22023'; END IF;
    INSERT INTO legacy_x.core_match_player_snapshots (match_id, user_id, snapshot_revision, snapshot)
    VALUES (v_match_id, v_user_id, v_match.revision, p_payload->'snapshot');
    UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'result_final' THEN
    IF v_match.state NOT IN ('LIVE', 'PAUSED') THEN RAISE EXCEPTION 'result only valid from LIVE or PAUSED' USING ERRCODE = '22023'; END IF;
    UPDATE legacy_x.core_matches SET state = 'FINISHED', final_event_id = p_event_id, result = p_payload->'result', finished_at = now(), revision = revision + 1, updated_at = now()
    WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'match_cancelled' THEN
    UPDATE legacy_x.core_matches SET state = 'CANCELLED', cancelled_at = now(), revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSE
    RAISE EXCEPTION 'unsupported Match Core event type %', v_type USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('status', 'processed', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision, 'slots_ready', legacy_x.core_match_active_slots_ready(v_match_id));
END;
$function$;

DROP VIEW IF EXISTS legacy_x.core_match_history;
CREATE VIEW legacy_x.core_match_history WITH (security_invoker = true) AS
SELECT cm.id AS match_id,
       cm.server_id,
       cm.matchzy_local_id,
       cm.state,
       cm.map_name,
       cm.map_number,
       cm.started_at,
       cm.finished_at,
       cm.result,
       count(cmp.user_id) AS original_participant_count
FROM legacy_x.core_matches cm
LEFT JOIN legacy_x.core_match_participants cmp ON cmp.match_id = cm.id
GROUP BY cm.id;
REVOKE ALL ON legacy_x.core_match_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON legacy_x.core_match_history TO service_role;

ALTER TABLE legacy_x.core_matches DROP COLUMN IF EXISTS season_id;

-- 2. Seasonal monthly rank (replaced by lifetime competitive EXP).
DROP VIEW IF EXISTS legacy_x.rank_leaderboard;
DROP VIEW IF EXISTS legacy_x.community_player_profiles;
DROP VIEW IF EXISTS legacy_x.community_clan_leaderboard;
DROP VIEW IF EXISTS legacy_x.community_experience_leaderboard;
DROP FUNCTION IF EXISTS legacy_x.ingest_rank_map_result(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.rollover_monthly_rank_season(timestamptz, text);
DROP FUNCTION IF EXISTS legacy_x.active_rank_season();
DROP TABLE IF EXISTS legacy_x.rank_match_results;
DROP TABLE IF EXISTS legacy_x.rank_player_seasons;
DROP TABLE IF EXISTS legacy_x.rank_season_archives;
DROP TABLE IF EXISTS legacy_x.rank_season_rollovers;

-- 3. Community XP levels and clans (clans are removed from the product; levels duplicated the rank).
DROP FUNCTION IF EXISTS legacy_x.ingest_community_map_result(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.community_level_from_experience(integer);
DROP FUNCTION IF EXISTS legacy_x.create_clan_with_leader(uuid, text, text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS legacy_x.delete_owned_clan(uuid, uuid);
DROP FUNCTION IF EXISTS legacy_x.join_clan(uuid, uuid);
DROP TABLE IF EXISTS legacy_x.community_match_experience;
DROP TABLE IF EXISTS legacy_x.community_event_receipts;
DROP TABLE IF EXISTS legacy_x.community_player_progression;
DROP TABLE IF EXISTS legacy_x.clan_season_scores;
DROP TABLE IF EXISTS legacy_x.clan_members;
DROP TABLE IF EXISTS legacy_x.clans;
DROP TYPE IF EXISTS legacy_x.clan_role;
-- Referenced by the clan/community tables above, so it goes last.
DROP TABLE IF EXISTS legacy_x.rank_seasons;
DROP TABLE IF EXISTS legacy_x.staff_team;

-- 4. Plugin match rows nothing writes: the Play page reads live reconnect heartbeats, history reads Match Core.
DROP FUNCTION IF EXISTS legacy_x.ingest_player_match_result(uuid, uuid, uuid, text, legacy_x.match_result, text, text, jsonb);
DROP TABLE IF EXISTS legacy_x.player_match_history;
DROP TABLE IF EXISTS legacy_x.match_favorites;
DROP TABLE IF EXISTS legacy_x.matches;
DROP TYPE IF EXISTS legacy_x.match_result;
DROP TYPE IF EXISTS legacy_x.match_status;
DROP TYPE IF EXISTS legacy_x.play_mode;

-- 5. Enum types left behind by the Shop/Wallet/Promo removal (no column uses them).
DROP TYPE IF EXISTS legacy_x.payment_method;
DROP TYPE IF EXISTS legacy_x.shop_rarity;
DROP TYPE IF EXISTS legacy_x.wallet_tx_type;

-- 6. Account-level notification switches for Settings (penalty notices are always on).
ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{"tournaments": true, "rank_changes": true}'::jsonb;

COMMIT;
