-- Creator ads on Home (owner request 2026-11-18): a content creator pays FOL$ to put one of their TikTok videos in the Home slider.
-- 24 hours = 5,000 FOL$, 48 hours = 8,000 FOL$. Only creators may buy. The banner picture is taken from the TikTok video itself (oEmbed) and kept here;
-- staff approve each one, the FOL$ is taken only when staff approve (a declined ad costs nothing). Safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.creator_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  tiktok_url text NOT NULL CHECK (char_length(tiktok_url) BETWEEN 20 AND 300),
  video_id text NOT NULL CHECK (video_id ~ '^[0-9]{8,25}$'),
  handle text NOT NULL CHECK (handle ~ '^@[A-Za-z0-9._]{2,24}$'),
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  image_mime text NOT NULL DEFAULT 'image/webp',
  image_data bytea NOT NULL,
  hours integer NOT NULL CHECK (hours IN (24, 48)),
  price integer NOT NULL CHECK (price > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  decided_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_ads_status_idx ON legacy_x.creator_ads (status, created_at);
CREATE INDEX IF NOT EXISTS creator_ads_user_idx ON legacy_x.creator_ads (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_ads_live_idx ON legacy_x.creator_ads (ends_at) WHERE status = 'approved';
ALTER TABLE legacy_x.creator_ads ENABLE ROW LEVEL SECURITY;

-- Approve: claim the still-pending row, take the price from the creator's wallet and start the clock, all in one transaction
-- (wallet_apply refuses when the balance is short, which undoes the claim). Returns the end of the run.
CREATE OR REPLACE FUNCTION legacy_x.creator_ad_approve(p_ad uuid, p_staff uuid) RETURNS timestamptz
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  v_row legacy_x.creator_ads%ROWTYPE;
  v_end timestamptz;
BEGIN
  SELECT * INTO v_row FROM legacy_x.creator_ads WHERE id = p_ad FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ad not found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This ad was already answered' USING ERRCODE = 'P0001'; END IF;
  PERFORM legacy_x.wallet_ensure(v_row.user_id, 0);
  PERFORM legacy_x.wallet_apply(v_row.user_id, -v_row.price, 'spend', 'Home banner ad (' || v_row.hours || ' h)', v_row.id::text, p_staff);
  v_end := now() + make_interval(hours => v_row.hours);
  UPDATE legacy_x.creator_ads SET status = 'approved', decided_by = p_staff, decided_at = now(), starts_at = now(), ends_at = v_end WHERE id = p_ad;
  RETURN v_end;
END $$;

REVOKE ALL ON FUNCTION legacy_x.creator_ad_approve(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.creator_ad_approve(uuid, uuid) TO service_role;

COMMIT;
