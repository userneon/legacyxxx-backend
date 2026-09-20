-- LEGACY-X player notifications: the feed behind the header bell.
--
-- Rows are written by the platform (today: a trigger on penalties), read by the owning player
-- through the API, and cleared by them. Safe to re-run.

CREATE TABLE IF NOT EXISTS legacy_x.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('penalty', 'match', 'system')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body TEXT CHECK (body IS NULL OR char_length(body) <= 500),
  /** Free-form context for the client, e.g. the penalty this notification came from. */
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The feed is always read newest-first for one player, and unread counts filter on read_at.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON legacy_x.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON legacy_x.notifications (user_id) WHERE read_at IS NULL;

-- Server-only table: the API reads it with the service role; browsers never query Supabase directly.
ALTER TABLE legacy_x.notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.notifications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.notifications TO service_role;

/**
 * A punishment is something the player must be told about, and the penalty row already carries
 * everything the message needs, so the feed is filled at the source rather than by a separate job.
 */
CREATE OR REPLACE FUNCTION legacy_x.notify_penalty_issued()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $function$
DECLARE
  v_label TEXT;
  v_duration TEXT;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_label := CASE NEW.type WHEN 'ban' THEN 'banned' WHEN 'comm' THEN 'muted' WHEN 'gag' THEN 'gagged' ELSE 'penalised' END;
  v_duration := CASE
    WHEN COALESCE(NEW.is_permanent, false) THEN 'Permanent'
    WHEN NULLIF(btrim(COALESCE(NEW.term, '')), '') IS NOT NULL THEN NEW.term
    ELSE NULL
  END;

  INSERT INTO legacy_x.notifications (user_id, kind, title, body, metadata)
  VALUES (
    NEW.user_id,
    'penalty',
    'You were ' || v_label,
    left(
      COALESCE(NULLIF(btrim(COALESCE(NEW.reason, '')), ''), 'No reason given')
        || COALESCE(' · ' || v_duration, ''),
      500
    ),
    jsonb_build_object('penaltyId', NEW.id, 'type', NEW.type, 'isPermanent', COALESCE(NEW.is_permanent, false))
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS notify_penalty_issued ON legacy_x.penalties;
CREATE TRIGGER notify_penalty_issued
AFTER INSERT ON legacy_x.penalties
FOR EACH ROW EXECUTE FUNCTION legacy_x.notify_penalty_issued();

-- Verification:
-- SELECT kind, title, body, read_at, created_at FROM legacy_x.notifications ORDER BY created_at DESC LIMIT 10;
