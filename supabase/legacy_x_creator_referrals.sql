-- Creator codes (owner request 2026-11-01): every content creator has a short code; a new player who plays their first ranked
-- match can enter it once and both get LX (the amounts are Staff -> Settings). Safe to re-run.

BEGIN;

ALTER TABLE legacy_x.content_creators ADD COLUMN IF NOT EXISTS referral_code text;
CREATE UNIQUE INDEX IF NOT EXISTS content_creators_referral_code_key ON legacy_x.content_creators (referral_code) WHERE referral_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS legacy_x.creator_referrals (
  referred_id uuid PRIMARY KEY REFERENCES legacy_x.users (id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES legacy_x.content_creators (user_id) ON DELETE CASCADE,
  code text NOT NULL,
  reward_referred integer NOT NULL CHECK (reward_referred >= 0),
  reward_creator integer NOT NULL CHECK (reward_creator >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creator_referrals_creator_idx ON legacy_x.creator_referrals (creator_id, created_at DESC);
ALTER TABLE legacy_x.creator_referrals ENABLE ROW LEVEL SECURITY;

COMMIT;
