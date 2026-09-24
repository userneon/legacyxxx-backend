-- Legacy-X v1: fixes that are safe while the previous API is still live (apply before legacy_x_v1_cleanup.sql).
--
-- 1. ingest_core_match_event wrote the core_match_events row before its core_matches row, so every
--    match_created failed core_match_events_match_id_fkey and no Match Core match was ever stored. The match
--    row now comes first; season_id is still filled from the active season when one exists (NULL otherwise),
--    so the previous API keeps working. Every other event type is unchanged.
-- 2. users.notification_prefs for Settings → Notifications.
-- 3. Profile privacy accepts 'loadout'.

BEGIN;

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
    IF EXISTS (SELECT 1 FROM legacy_x.core_match_events WHERE event_id = p_event_id) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    -- The match row first: core_match_events.match_id references it.
    INSERT INTO legacy_x.core_matches (id, server_id, matchzy_local_id, season_id, state, map_name, map_number)
    VALUES (
      v_match_id,
      p_payload->>'server_id',
      NULLIF(p_payload->>'matchzy_local_id', ''),
      (SELECT rs.id FROM legacy_x.rank_seasons rs WHERE rs.is_active ORDER BY rs.created_at DESC LIMIT 1),
      'WAITING',
      p_payload->>'map_name',
      COALESCE((p_payload->>'map_number')::INTEGER, 0)
    )
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, payload)
    VALUES (p_event_id, v_match_id, v_type, p_payload)
    ON CONFLICT (event_id) DO NOTHING;

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

ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{"tournaments": true, "rank_changes": true}'::jsonb;

ALTER TABLE legacy_x.users
  DROP CONSTRAINT IF EXISTS users_hidden_profile_sections_known;
ALTER TABLE legacy_x.users
  ADD CONSTRAINT users_hidden_profile_sections_known
  CHECK (hidden_profile_sections <@ ARRAY['kd', 'matches', 'kills', 'faceit', 'recent_matches', 'loadout']::TEXT[]);

COMMIT;
