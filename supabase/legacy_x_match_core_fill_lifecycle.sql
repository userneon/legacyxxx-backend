BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.core_match_slot_fill_reward_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
BEGIN
  IF NEW.active_role = 'fill' AND COALESCE(OLD.active_role, '') <> 'fill' THEN
    UPDATE legacy_x.core_match_participants
    SET eligible_for_rewards = false, updated_at = now()
    WHERE match_id = NEW.match_id AND user_id = NEW.original_user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS core_match_slot_fill_reward_policy_trigger ON legacy_x.core_match_slots;
CREATE TRIGGER core_match_slot_fill_reward_policy_trigger
AFTER UPDATE OF active_role ON legacy_x.core_match_slots
FOR EACH ROW EXECUTE FUNCTION legacy_x.core_match_slot_fill_reward_policy();

CREATE OR REPLACE FUNCTION legacy_x.remove_core_match_fill(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_match_id UUID,
  p_expected_revision INTEGER,
  p_steam_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_match legacy_x.core_matches%ROWTYPE;
  v_fill_user_id UUID;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN RAISE EXCEPTION 'Unsupported Match Core plugin' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_match FROM legacy_x.core_matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown match_id' USING ERRCODE = '22023'; END IF;
  IF p_expected_revision <> v_match.revision THEN RETURN jsonb_build_object('status', 'stale', 'match_id', p_match_id, 'state', v_match.state, 'revision', v_match.revision); END IF;
  INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, expected_revision, payload)
  VALUES (p_event_id, p_match_id, 'fill_removed', p_expected_revision, jsonb_build_object('steam_id', p_steam_id))
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'duplicate', 'match_id', p_match_id, 'state', v_match.state, 'revision', v_match.revision); END IF;
  SELECT id INTO v_fill_user_id FROM legacy_x.users WHERE steam_id = p_steam_id;
  UPDATE legacy_x.core_match_slots
  SET active_user_id = NULL, active_role = NULL, fill_user_id = NULL, updated_at = now()
  WHERE match_id = p_match_id AND active_user_id = v_fill_user_id AND active_role = 'fill';
  IF NOT FOUND THEN RAISE EXCEPTION 'active temporary fill not found' USING ERRCODE = '22023'; END IF;
  UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = p_match_id RETURNING * INTO v_match;
  RETURN jsonb_build_object('status', 'processed', 'match_id', p_match_id, 'state', v_match.state, 'revision', v_match.revision, 'slots_ready', legacy_x.core_match_active_slots_ready(p_match_id));
END;
$$;

GRANT EXECUTE ON FUNCTION legacy_x.remove_core_match_fill(TEXT, TEXT, UUID, INTEGER, TEXT) TO service_role;

COMMIT;
