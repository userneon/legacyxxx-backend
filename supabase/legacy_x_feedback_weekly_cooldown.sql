-- Enforce the LEGACY-X rule: one feedback review per user every seven days.
-- The advisory transaction lock makes simultaneous requests from the same user atomic.
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.submit_feedback_weekly(
  p_user_id uuid,
  p_name text,
  p_rating integer,
  p_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_last_created_at timestamptz;
  v_feedback legacy_x.feedback%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT created_at
  INTO v_last_created_at
  FROM legacy_x.feedback
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_last_created_at IS NOT NULL
     AND v_last_created_at > now() - interval '7 days' THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'next_eligible_at', v_last_created_at + interval '7 days'
    );
  END IF;

  INSERT INTO legacy_x.feedback (user_id, name, rating, message)
  VALUES (p_user_id, p_name, p_rating, p_message)
  RETURNING * INTO v_feedback;

  RETURN jsonb_build_object(
    'accepted', true,
    'feedback', jsonb_build_object(
      'id', v_feedback.id,
      'user_id', v_feedback.user_id,
      'name', v_feedback.name,
      'rating', v_feedback.rating,
      'message', v_feedback.message,
      'created_at', v_feedback.created_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION legacy_x.submit_feedback_weekly(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.submit_feedback_weekly(uuid, text, integer, text) TO service_role;

COMMIT;
