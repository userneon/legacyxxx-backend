-- Settings → Notifications → "Rank changes" had a switch but nothing ever wrote such a notice. A player now gets one in the bell
-- whenever their rank moves (up or down), unless they turned the switch off (users.notification_prefs.rank_changes = false).
-- Additive: one function and one trigger. Safe to re-run.
CREATE OR REPLACE FUNCTION legacy_x.notify_rank_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $fn$
DECLARE
  v_wants BOOLEAN;
  v_old_name TEXT;
  v_new_name TEXT;
  v_up BOOLEAN;
BEGIN
  SELECT COALESCE((notification_prefs->>'rank_changes')::boolean, true) INTO v_wants FROM legacy_x.users WHERE id = NEW.user_id;
  IF NOT COALESCE(v_wants, true) THEN
    RETURN NEW;
  END IF;
  SELECT display_name INTO v_old_name FROM legacy_x.competitive_rank_definitions WHERE rank_id = OLD.current_rank_id;
  SELECT display_name INTO v_new_name FROM legacy_x.competitive_rank_definitions WHERE rank_id = NEW.current_rank_id;
  IF v_new_name IS NULL THEN
    RETURN NEW;
  END IF;
  v_up := NEW.current_rank_id > COALESCE(OLD.current_rank_id, 0);
  INSERT INTO legacy_x.notifications (user_id, kind, title, body, metadata)
  VALUES (
    NEW.user_id,
    'match',
    left(CASE WHEN v_up THEN 'Rank up: ' ELSE 'Rank down: ' END || v_new_name, 120),
    left('You are now ' || v_new_name || COALESCE(' (was ' || v_old_name || ')', '') || ' with ' || NEW.current_exp || ' EXP.', 500),
    jsonb_build_object('kind', 'rank_change', 'from', OLD.current_rank_id, 'to', NEW.current_rank_id, 'up', v_up)
  );
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION legacy_x.notify_rank_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS notify_rank_change ON legacy_x.competitive_player_progression;
CREATE TRIGGER notify_rank_change
AFTER UPDATE OF current_rank_id ON legacy_x.competitive_player_progression
FOR EACH ROW
WHEN (OLD.current_rank_id IS DISTINCT FROM NEW.current_rank_id)
EXECUTE FUNCTION legacy_x.notify_rank_change();
