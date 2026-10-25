-- Clan level, clan bank and Clan War (owner request 2026-10-25, "clan features are limited"). Rules in server/legacyX/clanProgress.ts.
-- Safe to re-run.
BEGIN;

-- Level and war record. XP only grows through add_clan_xp (one row of clan_xp_log per reason, so a replayed match pays once).
CREATE TABLE IF NOT EXISTS legacy_x.clan_progress (
  clan_id uuid PRIMARY KEY REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  xp integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  perk_level integer NOT NULL DEFAULT 1,
  war_rating integer NOT NULL DEFAULT 1000,
  war_wins integer NOT NULL DEFAULT 0,
  war_losses integer NOT NULL DEFAULT 0,
  war_draws integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS legacy_x.clan_xp_log (
  ref text PRIMARY KEY,
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  xp integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clan_xp_log_clan_idx ON legacy_x.clan_xp_log (clan_id, created_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.add_clan_xp(p_clan_id uuid, p_ref text, p_xp integer, p_reason text)
RETURNS integer LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  total integer;
BEGIN
  INSERT INTO legacy_x.clan_xp_log (ref, clan_id, xp, reason) VALUES (p_ref, p_clan_id, p_xp, p_reason) ON CONFLICT (ref) DO NOTHING;
  IF NOT FOUND THEN
    SELECT p.xp INTO total FROM legacy_x.clan_progress p WHERE p.clan_id = p_clan_id;
    RETURN COALESCE(total, 0);
  END IF;
  INSERT INTO legacy_x.clan_progress AS p (clan_id, xp) VALUES (p_clan_id, GREATEST(p_xp, 0))
  ON CONFLICT (clan_id) DO UPDATE SET xp = GREATEST(p.xp + p_xp, 0), updated_at = now()
  RETURNING p.xp INTO total;
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION legacy_x.add_clan_xp(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.add_clan_xp(uuid, text, integer, text) TO service_role;

-- The clan bank: members give LX from their own wallet; the leader spends it on the clan (member slots, a new name or tag).
CREATE TABLE IF NOT EXISTS legacy_x.clan_bank (
  clan_id uuid PRIMARY KEY REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS legacy_x.clan_bank_log (
  id bigserial PRIMARY KEY,
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  user_id uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  amount integer NOT NULL CHECK (amount <> 0),
  reason text NOT NULL,
  ref text NOT NULL UNIQUE,
  balance_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clan_bank_log_clan_idx ON legacy_x.clan_bank_log (clan_id, created_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.clan_bank_apply(p_clan_id uuid, p_user_id uuid, p_amount integer, p_reason text, p_ref text)
RETURNS integer LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  current_balance integer;
  earlier integer;
BEGIN
  IF p_amount = 0 THEN RAISE EXCEPTION 'amount must not be zero' USING ERRCODE = '22023'; END IF;
  INSERT INTO legacy_x.clan_bank (clan_id) VALUES (p_clan_id) ON CONFLICT (clan_id) DO NOTHING;
  SELECT b.balance INTO current_balance FROM legacy_x.clan_bank b WHERE b.clan_id = p_clan_id FOR UPDATE;
  SELECT l.balance_after INTO earlier FROM legacy_x.clan_bank_log l WHERE l.ref = p_ref;
  IF FOUND THEN RETURN earlier; END IF;
  IF current_balance + p_amount < 0 THEN RAISE EXCEPTION 'insufficient bank' USING ERRCODE = 'P0001'; END IF;
  UPDATE legacy_x.clan_bank SET balance = current_balance + p_amount, updated_at = now() WHERE clan_id = p_clan_id;
  INSERT INTO legacy_x.clan_bank_log (clan_id, user_id, amount, reason, ref, balance_after) VALUES (p_clan_id, p_user_id, p_amount, p_reason, p_ref, current_balance + p_amount);
  RETURN current_balance + p_amount;
END $$;
REVOKE ALL ON FUNCTION legacy_x.clan_bank_apply(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.clan_bank_apply(uuid, uuid, integer, text, text) TO service_role;

-- Clan War: one clan challenges another for a time and map; the result comes from the ranked match the two clans play then.
CREATE TABLE IF NOT EXISTS legacy_x.clan_wars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenger_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  opponent_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'finished', 'expired')),
  map_name text NOT NULL CHECK (map_name ~ '^[a-z0-9_]{3,40}$'),
  scheduled_at timestamptz NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 140),
  created_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  answered_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  match_id uuid,
  winner_id uuid REFERENCES legacy_x.clans(id) ON DELETE SET NULL,
  score_challenger integer,
  score_opponent integer,
  rating_change integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (challenger_id <> opponent_id)
);
CREATE INDEX IF NOT EXISTS clan_wars_challenger_idx ON legacy_x.clan_wars (challenger_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS clan_wars_opponent_idx ON legacy_x.clan_wars (opponent_id, scheduled_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS clan_wars_match_idx ON legacy_x.clan_wars (match_id) WHERE match_id IS NOT NULL;

ALTER TABLE legacy_x.clan_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_xp_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_bank_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_wars ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_progress, legacy_x.clan_xp_log, legacy_x.clan_bank, legacy_x.clan_bank_log, legacy_x.clan_wars FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_progress, legacy_x.clan_xp_log, legacy_x.clan_bank, legacy_x.clan_bank_log, legacy_x.clan_wars TO service_role;
GRANT USAGE, SELECT ON SEQUENCE legacy_x.clan_bank_log_id_seq TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
