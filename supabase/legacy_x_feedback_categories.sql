-- Reviews carry a category and a score with one decimal (4.6, 4.7), picked on a slider (owner request 2026-10-30).
-- Older reviews keep their whole stars and sit in "general". The old integer function stays so a backend that is not yet updated still works.
BEGIN;

ALTER TABLE legacy_x.feedback DROP CONSTRAINT IF EXISTS feedback_rating_check;
ALTER TABLE legacy_x.feedback ALTER COLUMN rating TYPE numeric(2, 1) USING rating::numeric(2, 1);
ALTER TABLE legacy_x.feedback ADD CONSTRAINT feedback_rating_check CHECK (rating >= 1 AND rating <= 5);

ALTER TABLE legacy_x.feedback ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'general';
ALTER TABLE legacy_x.feedback DROP CONSTRAINT IF EXISTS feedback_category_check;
ALTER TABLE legacy_x.feedback ADD CONSTRAINT feedback_category_check
  CHECK (category IN ('general', 'servers', 'matches', 'skinchanger', 'shop', 'website'));

CREATE OR REPLACE FUNCTION legacy_x.submit_feedback_weekly(
  p_user_id uuid,
  p_name text,
  p_rating numeric,
  p_message text,
  p_category text
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

  SELECT created_at INTO v_last_created_at
  FROM legacy_x.feedback
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_last_created_at IS NOT NULL AND v_last_created_at > now() - interval '7 days' THEN
    RETURN jsonb_build_object('accepted', false, 'next_eligible_at', v_last_created_at + interval '7 days');
  END IF;

  INSERT INTO legacy_x.feedback (user_id, name, rating, message, category)
  VALUES (p_user_id, p_name, p_rating, p_message, p_category)
  RETURNING * INTO v_feedback;

  RETURN jsonb_build_object(
    'accepted', true,
    'feedback', jsonb_build_object(
      'id', v_feedback.id,
      'user_id', v_feedback.user_id,
      'name', v_feedback.name,
      'rating', v_feedback.rating,
      'category', v_feedback.category,
      'message', v_feedback.message,
      'created_at', v_feedback.created_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION legacy_x.submit_feedback_weekly(uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.submit_feedback_weekly(uuid, text, numeric, text, text) TO service_role;

COMMIT;
