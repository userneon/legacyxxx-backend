BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.core_matches (
  id UUID PRIMARY KEY,
  server_id TEXT NOT NULL,
  matchzy_local_id TEXT,
  season_id UUID REFERENCES legacy_x.rank_seasons(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('WAITING', 'LIVE', 'PAUSED', 'FINISHED', 'CANCELLED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  map_name TEXT NOT NULL,
  map_number INTEGER NOT NULL DEFAULT 0 CHECK (map_number >= 0),
  pause_reason TEXT,
  paused_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  final_event_id TEXT UNIQUE,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.core_match_participants (
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  team_key TEXT NOT NULL CHECK (team_key IN ('team1', 'team2')),
  slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 1 AND 5),
  original_name TEXT NOT NULL,
  connected BOOLEAN NOT NULL DEFAULT true,
  disconnected_at TIMESTAMPTZ,
  reconnect_deadline TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  eligible_for_rewards BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id),
  UNIQUE (match_id, steam_id),
  UNIQUE (match_id, team_key, slot_index)
);

CREATE TABLE IF NOT EXISTS legacy_x.core_match_slots (
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE CASCADE,
  team_key TEXT NOT NULL CHECK (team_key IN ('team1', 'team2')),
  slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 1 AND 5),
  original_user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  active_user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  active_role TEXT CHECK (active_role IN ('original', 'fill')),
  fill_user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, team_key, slot_index),
  CHECK ((active_user_id IS NULL AND active_role IS NULL) OR (active_user_id IS NOT NULL AND active_role IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS legacy_x.core_match_player_snapshots (
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision > 0),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id, snapshot_revision)
);

CREATE TABLE IF NOT EXISTS legacy_x.core_match_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('match_created', 'state_transition', 'player_disconnected', 'player_returned', 'fill_assigned', 'fill_removed', 'snapshot_saved', 'result_final', 'match_cancelled')),
  expected_revision INTEGER,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS core_matches_state_idx ON legacy_x.core_matches (state, updated_at DESC);
CREATE INDEX IF NOT EXISTS core_participants_steam_idx ON legacy_x.core_match_participants (steam_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS core_events_match_idx ON legacy_x.core_match_events (match_id, created_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.core_match_active_slots_ready(p_match_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
  SELECT COUNT(*) = 10
  FROM legacy_x.core_match_slots
  WHERE match_id = p_match_id
    AND active_user_id IS NOT NULL
    AND active_role IN ('original', 'fill');
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_core_match_event(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
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
    INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, payload)
    VALUES (p_event_id, v_match_id, v_type, p_payload)
    ON CONFLICT (event_id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    INSERT INTO legacy_x.core_matches (id, server_id, matchzy_local_id, season_id, state, map_name, map_number)
    SELECT v_match_id,
           p_payload->>'server_id',
           NULLIF(p_payload->>'matchzy_local_id', ''),
           rs.id,
           'WAITING',
           p_payload->>'map_name',
           COALESCE((p_payload->>'map_number')::INTEGER, 0)
      FROM legacy_x.rank_seasons rs
     WHERE rs.is_active
     ORDER BY rs.created_at DESC
     LIMIT 1
    ON CONFLICT (id) DO NOTHING;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
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
$$;

CREATE OR REPLACE VIEW legacy_x.core_match_history AS
SELECT
  cm.id AS match_id,
  cm.server_id,
  cm.matchzy_local_id,
  cm.state,
  cm.map_name,
  cm.map_number,
  cm.started_at,
  cm.finished_at,
  cm.result,
  rs.slug AS season_slug,
  COUNT(cmp.user_id) AS original_participant_count
FROM legacy_x.core_matches cm
LEFT JOIN legacy_x.rank_seasons rs ON rs.id = cm.season_id
LEFT JOIN legacy_x.core_match_participants cmp ON cmp.match_id = cm.id
GROUP BY cm.id, rs.slug;

ALTER TABLE legacy_x.core_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.core_match_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.core_match_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.core_match_player_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.core_match_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.core_matches, legacy_x.core_match_participants, legacy_x.core_match_slots, legacy_x.core_match_player_snapshots, legacy_x.core_match_events FROM anon, authenticated;
REVOKE ALL ON legacy_x.core_match_history FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.core_matches, legacy_x.core_match_participants, legacy_x.core_match_slots, legacy_x.core_match_player_snapshots, legacy_x.core_match_events TO service_role;
GRANT SELECT ON legacy_x.core_match_history TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB), legacy_x.core_match_active_slots_ready(UUID) TO service_role;

COMMIT;
