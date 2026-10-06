-- Coin wallet: one balance per player and an append-only ledger behind it.
--
-- Every change goes through wallet_apply(): it locks the player's wallet row, refuses to go below zero, writes the
-- ledger line and returns the new balance in one transaction. An optional `ref` makes a change idempotent: asking
-- again with the same ref changes nothing and returns the balance from the first time (safe to retry a grant or a
-- clan fee). The ledger is never updated or deleted. Only the Root API (service_role) reads or writes these tables.
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.wallets (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.wallet_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK (amount <> 0),
  kind text NOT NULL CHECK (kind IN ('grant', 'spend', 'refund', 'adjust')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  ref text CHECK (ref IS NULL OR char_length(ref) BETWEEN 1 AND 120),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  created_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('grant', 'refund') AND amount > 0) OR (kind = 'spend' AND amount < 0) OR kind = 'adjust')
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_user_ref_idx ON legacy_x.wallet_transactions (user_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_transactions_user_created_idx ON legacy_x.wallet_transactions (user_id, created_at DESC);

ALTER TABLE legacy_x.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.wallet_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.wallets, legacy_x.wallet_transactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON legacy_x.wallets, legacy_x.wallet_transactions TO service_role;

-- The ledger cannot be edited or removed, whoever asks.
CREATE OR REPLACE FUNCTION legacy_x.wallet_transactions_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions is append-only' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS wallet_transactions_no_change ON legacy_x.wallet_transactions;
CREATE TRIGGER wallet_transactions_no_change BEFORE UPDATE OR DELETE ON legacy_x.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION legacy_x.wallet_transactions_append_only();

-- Applies one change. Returns the balance after it and whether it was applied (false = this ref was already used).
CREATE OR REPLACE FUNCTION legacy_x.wallet_apply(
  p_user_id uuid, p_amount integer, p_kind text, p_reason text, p_ref text DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS TABLE (new_balance integer, applied boolean)
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  current_balance integer;
  earlier integer;
BEGIN
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'amount must not be zero' USING ERRCODE = '22023';
  END IF;
  IF (p_kind IN ('grant', 'refund') AND p_amount < 0) OR (p_kind = 'spend' AND p_amount > 0) OR p_kind NOT IN ('grant', 'spend', 'refund', 'adjust') THEN
    RAISE EXCEPTION 'amount does not fit the kind' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  -- The lock comes first, so two requests with the same ref cannot both pass the check below.
  SELECT w.balance INTO current_balance FROM legacy_x.wallets w WHERE w.user_id = p_user_id FOR UPDATE;

  IF p_ref IS NOT NULL THEN
    SELECT t.balance_after INTO earlier FROM legacy_x.wallet_transactions t WHERE t.user_id = p_user_id AND t.ref = p_ref;
    IF FOUND THEN
      RETURN QUERY SELECT earlier, false;
      RETURN;
    END IF;
  END IF;

  IF current_balance + p_amount < 0 THEN
    RAISE EXCEPTION 'insufficient coins' USING ERRCODE = 'P0001';
  END IF;

  UPDATE legacy_x.wallets SET balance = current_balance + p_amount, updated_at = now() WHERE user_id = p_user_id;
  INSERT INTO legacy_x.wallet_transactions (user_id, amount, kind, reason, ref, balance_after, created_by)
  VALUES (p_user_id, p_amount, p_kind, p_reason, p_ref, current_balance + p_amount, p_actor);
  RETURN QUERY SELECT current_balance + p_amount, true;
END $$;

REVOKE ALL ON FUNCTION legacy_x.wallet_apply(uuid, integer, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.wallet_apply(uuid, integer, text, text, text, uuid) TO service_role;

COMMIT;
