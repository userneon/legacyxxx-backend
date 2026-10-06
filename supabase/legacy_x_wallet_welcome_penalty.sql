-- Wallet, part 2: a welcome bonus for every new wallet and a "penalty" that takes coins away.
--
-- wallet_ensure() opens a player's wallet the first time anything touches it and, in that same step, writes the
-- welcome bonus into the ledger (ref 'welcome', so it can only happen once). wallet_penalize() takes up to the
-- given amount (never more than the balance, so a wallet never goes below zero) and records what it actually took
-- as a 'penalty' line; a repeated ref takes nothing twice. Safe to re-run.

BEGIN;

ALTER TABLE legacy_x.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_kind_check;
ALTER TABLE legacy_x.wallet_transactions ADD CONSTRAINT wallet_transactions_kind_check CHECK (kind IN ('grant', 'spend', 'refund', 'adjust', 'penalty'));
ALTER TABLE legacy_x.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_check;
ALTER TABLE legacy_x.wallet_transactions ADD CONSTRAINT wallet_transactions_check CHECK (
  (kind IN ('grant', 'refund') AND amount > 0) OR (kind IN ('spend', 'penalty') AND amount < 0) OR kind = 'adjust'
);

CREATE OR REPLACE FUNCTION legacy_x.wallet_ensure(p_user_id uuid, p_welcome integer DEFAULT 0)
RETURNS integer
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  created integer;
  current_balance integer;
BEGIN
  INSERT INTO legacy_x.wallets (user_id, balance) VALUES (p_user_id, GREATEST(p_welcome, 0)) ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS created = ROW_COUNT;
  IF created = 1 AND p_welcome > 0 THEN
    INSERT INTO legacy_x.wallet_transactions (user_id, amount, kind, reason, ref, balance_after)
    VALUES (p_user_id, p_welcome, 'grant', 'Welcome bonus', 'welcome', p_welcome);
  END IF;
  SELECT w.balance INTO current_balance FROM legacy_x.wallets w WHERE w.user_id = p_user_id;
  RETURN current_balance;
END $$;

CREATE OR REPLACE FUNCTION legacy_x.wallet_penalize(
  p_user_id uuid, p_amount integer, p_reason text, p_ref text DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS TABLE (new_balance integer, taken integer, applied boolean)
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  current_balance integer;
  earlier_amount integer;
  earlier_balance integer;
  take integer;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive' USING ERRCODE = '22023';
  END IF;
  SELECT w.balance INTO current_balance FROM legacy_x.wallets w WHERE w.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF p_ref IS NOT NULL THEN
    SELECT -t.amount, t.balance_after INTO earlier_amount, earlier_balance
      FROM legacy_x.wallet_transactions t WHERE t.user_id = p_user_id AND t.ref = p_ref;
    IF FOUND THEN
      RETURN QUERY SELECT earlier_balance, earlier_amount, false;
      RETURN;
    END IF;
  END IF;
  take := LEAST(p_amount, current_balance);
  IF take = 0 THEN
    RETURN QUERY SELECT current_balance, 0, false;
    RETURN;
  END IF;
  UPDATE legacy_x.wallets SET balance = current_balance - take, updated_at = now() WHERE user_id = p_user_id;
  INSERT INTO legacy_x.wallet_transactions (user_id, amount, kind, reason, ref, balance_after, created_by)
  VALUES (p_user_id, -take, 'penalty', p_reason, p_ref, current_balance - take, p_actor);
  RETURN QUERY SELECT current_balance - take, take, true;
END $$;

REVOKE ALL ON FUNCTION legacy_x.wallet_ensure(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.wallet_ensure(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION legacy_x.wallet_penalize(uuid, integer, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.wallet_penalize(uuid, integer, text, text, uuid) TO service_role;

COMMIT;
