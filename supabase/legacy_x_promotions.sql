BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.promotion_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 3 AND 96),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('legacyx', 'creator', 'partner')),
  owner_user_id UUID NULL REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  benefit_type TEXT NOT NULL CHECK (benefit_type IN ('wallet_credit', 'wallet_rate_override', 'wallet_percent', 'wallet_fixed', 'store_percent', 'store_fixed', 'admin_role')),
  benefit_value INTEGER NOT NULL CHECK (benefit_value >= 0 AND benefit_value <= 1000000),
  starts_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  max_redemptions INTEGER NULL CHECK (max_redemptions > 0),
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit > 0 AND per_user_limit <= 100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID NULL REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_kind = 'legacyx') OR owner_user_id IS NOT NULL),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at),
  CHECK ((benefit_type <> 'admin_role') OR owner_kind = 'legacyx'),
  CHECK ((benefit_type NOT IN ('wallet_percent', 'store_percent')) OR benefit_value BETWEEN 0 AND 100),
  CHECK ((benefit_type <> 'wallet_rate_override') OR benefit_value >= 1)
);

CREATE TABLE IF NOT EXISTS legacy_x.promotion_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES legacy_x.promotion_campaigns(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE CHECK (char_length(code_hash) = 64),
  code_hint TEXT NOT NULL CHECK (char_length(code_hint) BETWEEN 3 AND 32),
  max_redemptions INTEGER NULL CHECK (max_redemptions > 0),
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  per_user_limit INTEGER NULL CHECK (per_user_limit > 0 AND per_user_limit <= 100),
  starts_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID NULL REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE IF NOT EXISTS legacy_x.promotion_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES legacy_x.promotion_campaigns(id) ON DELETE RESTRICT,
  code_id UUID NOT NULL REFERENCES legacy_x.promotion_codes(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  context TEXT NOT NULL CHECK (context IN ('wallet_redeem', 'store_purchase')),
  status TEXT NOT NULL DEFAULT 'redeemed' CHECK (status IN ('redeemed', 'revoked')),
  benefit_type TEXT NOT NULL,
  benefit_value INTEGER NOT NULL,
  code_hint TEXT NOT NULL,
  idempotency_key TEXT NULL CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 96),
  wallet_transaction_id UUID NULL REFERENCES legacy_x.wallet_transactions(id) ON DELETE SET NULL,
  store_purchase_id UUID NULL REFERENCES legacy_x.store_purchases(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS legacy_x.user_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('admin_role')),
  promotion_redemption_id UUID NOT NULL UNIQUE REFERENCES legacy_x.promotion_redemptions(id) ON DELETE RESTRICT,
  granted_role TEXT NULL CHECK (granted_role IN ('Admin')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promotion_campaigns_active_idx ON legacy_x.promotion_campaigns (is_active, starts_at, expires_at);
CREATE INDEX IF NOT EXISTS promotion_codes_campaign_idx ON legacy_x.promotion_codes (campaign_id, is_active);
CREATE INDEX IF NOT EXISTS promotion_redemptions_user_created_idx ON legacy_x.promotion_redemptions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS promotion_redemptions_code_user_idx ON legacy_x.promotion_redemptions (code_id, user_id) WHERE status = 'redeemed';
CREATE INDEX IF NOT EXISTS user_entitlements_user_active_idx ON legacy_x.user_entitlements (user_id, kind) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION legacy_x.quote_promotion_code(
  p_user_id UUID,
  p_code_hash TEXT,
  p_context TEXT,
  p_coin_amount INTEGER DEFAULT NULL,
  p_item_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_code legacy_x.promotion_codes%ROWTYPE;
  v_campaign legacy_x.promotion_campaigns%ROWTYPE;
  v_used INTEGER;
  v_limit INTEGER;
  v_base INTEGER;
  v_final INTEGER;
  v_message TEXT;
BEGIN
  SELECT c.* INTO v_code FROM legacy_x.promotion_codes c WHERE c.code_hash = p_code_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'Promotion code is invalid' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_campaign FROM legacy_x.promotion_campaigns WHERE id = v_code.campaign_id;
  IF NOT v_code.is_active OR NOT v_campaign.is_active THEN RAISE EXCEPTION 'Promotion code is inactive' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.starts_at IS NOT NULL AND v_code.starts_at > now()) OR (v_campaign.starts_at IS NOT NULL AND v_campaign.starts_at > now()) THEN RAISE EXCEPTION 'Promotion code is not active yet' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.expires_at IS NOT NULL AND v_code.expires_at <= now()) OR (v_campaign.expires_at IS NOT NULL AND v_campaign.expires_at <= now()) THEN RAISE EXCEPTION 'Promotion code has expired' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.max_redemptions IS NOT NULL AND v_code.redemption_count >= v_code.max_redemptions) OR (v_campaign.max_redemptions IS NOT NULL AND v_campaign.redemption_count >= v_campaign.max_redemptions) THEN RAISE EXCEPTION 'Promotion code usage limit has been reached' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_used FROM legacy_x.promotion_redemptions WHERE code_id = v_code.id AND user_id = p_user_id AND status = 'redeemed';
  v_limit := COALESCE(v_code.per_user_limit, v_campaign.per_user_limit);
  IF v_used >= v_limit THEN RAISE EXCEPTION 'You have already used this promotion code' USING ERRCODE = 'P0001'; END IF;

  IF p_context = 'wallet_topup' THEN
    IF p_coin_amount IS NULL OR p_coin_amount <= 0 THEN RAISE EXCEPTION 'Coin amount is required' USING ERRCODE = '22023'; END IF;
    v_base := p_coin_amount * 2000;
    IF v_campaign.benefit_type = 'wallet_rate_override' THEN v_final := p_coin_amount * v_campaign.benefit_value;
    ELSIF v_campaign.benefit_type = 'wallet_percent' THEN v_final := ceil(v_base * GREATEST(0, 100 - v_campaign.benefit_value) / 100.0);
    ELSIF v_campaign.benefit_type = 'wallet_fixed' THEN v_final := GREATEST(0, v_base - v_campaign.benefit_value);
    ELSE RAISE EXCEPTION 'Promotion code does not apply to wallet top-up' USING ERRCODE = 'P0001'; END IF;
    v_message := 'Promotion is ready for verified payment checkout';
  ELSIF p_context = 'store_purchase' THEN
    SELECT price INTO v_base FROM legacy_x.store_items WHERE id = p_item_id;
    IF v_base IS NULL THEN RAISE EXCEPTION 'Store item was not found' USING ERRCODE = 'P0002'; END IF;
    IF v_campaign.benefit_type = 'store_percent' THEN v_final := ceil(v_base * GREATEST(0, 100 - v_campaign.benefit_value) / 100.0);
    ELSIF v_campaign.benefit_type = 'store_fixed' THEN v_final := GREATEST(0, v_base - v_campaign.benefit_value);
    ELSE RAISE EXCEPTION 'Promotion code does not apply to store purchase' USING ERRCODE = 'P0001'; END IF;
    v_message := 'Promotion is ready for store checkout';
  ELSIF p_context = 'wallet_redeem' THEN
    IF v_campaign.benefit_type NOT IN ('wallet_credit', 'admin_role') THEN RAISE EXCEPTION 'Promotion code needs a purchase or top-up context' USING ERRCODE = 'P0001'; END IF;
    v_base := v_campaign.benefit_value;
    v_final := v_campaign.benefit_value;
    v_message := CASE WHEN v_campaign.benefit_type = 'admin_role' THEN 'LEGACY-X Admin entitlement will be granted' ELSE 'Wallet coins will be granted' END;
  ELSE
    RAISE EXCEPTION 'Unsupported promotion context' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('codeHint', v_code.code_hint, 'campaignName', v_campaign.name, 'ownerKind', v_campaign.owner_kind, 'benefitType', v_campaign.benefit_type, 'context', p_context, 'baseAmount', v_base, 'finalAmount', v_final, 'discountAmount', GREATEST(0, v_base - v_final), 'currency', CASE WHEN p_context = 'wallet_topup' THEN 'MNT' ELSE 'coins' END, 'redeemable', p_context = 'wallet_redeem', 'message', v_message);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.redeem_promotion_code(
  p_user_id UUID,
  p_code_hash TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_code legacy_x.promotion_codes%ROWTYPE;
  v_campaign legacy_x.promotion_campaigns%ROWTYPE;
  v_redemption legacy_x.promotion_redemptions%ROWTYPE;
  v_existing legacy_x.promotion_redemptions%ROWTYPE;
  v_transaction_id UUID;
  v_entitlement_id UUID;
  v_used INTEGER;
  v_limit INTEGER;
  v_balance INTEGER;
  v_role TEXT;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM legacy_x.promotion_redemptions WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT balance, role INTO v_balance, v_role FROM legacy_x.users WHERE id = p_user_id;
      RETURN jsonb_build_object('redemptionId', v_existing.id, 'alreadyRedeemed', true, 'benefitType', v_existing.benefit_type, 'benefitValue', v_existing.benefit_value, 'balance', v_balance, 'role', v_role);
    END IF;
  END IF;
  SELECT * INTO v_code FROM legacy_x.promotion_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Promotion code is invalid' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_campaign FROM legacy_x.promotion_campaigns WHERE id = v_code.campaign_id FOR UPDATE;
  IF NOT v_code.is_active OR NOT v_campaign.is_active THEN RAISE EXCEPTION 'Promotion code is inactive' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.starts_at IS NOT NULL AND v_code.starts_at > now()) OR (v_campaign.starts_at IS NOT NULL AND v_campaign.starts_at > now()) OR (v_code.expires_at IS NOT NULL AND v_code.expires_at <= now()) OR (v_campaign.expires_at IS NOT NULL AND v_campaign.expires_at <= now()) THEN RAISE EXCEPTION 'Promotion code is unavailable' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.max_redemptions IS NOT NULL AND v_code.redemption_count >= v_code.max_redemptions) OR (v_campaign.max_redemptions IS NOT NULL AND v_campaign.redemption_count >= v_campaign.max_redemptions) THEN RAISE EXCEPTION 'Promotion code usage limit has been reached' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_used FROM legacy_x.promotion_redemptions WHERE code_id = v_code.id AND user_id = p_user_id AND status = 'redeemed';
  v_limit := COALESCE(v_code.per_user_limit, v_campaign.per_user_limit);
  IF v_used >= v_limit THEN RAISE EXCEPTION 'You have already used this promotion code' USING ERRCODE = 'P0001'; END IF;
  IF v_campaign.benefit_type NOT IN ('wallet_credit', 'admin_role') THEN RAISE EXCEPTION 'This promotion must be redeemed during verified checkout' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO legacy_x.promotion_redemptions (campaign_id, code_id, user_id, context, benefit_type, benefit_value, code_hint, idempotency_key, metadata)
  VALUES (v_campaign.id, v_code.id, p_user_id, 'wallet_redeem', v_campaign.benefit_type, v_campaign.benefit_value, v_code.code_hint, p_idempotency_key, jsonb_build_object('ownerKind', v_campaign.owner_kind))
  RETURNING * INTO v_redemption;
  IF v_campaign.benefit_type = 'wallet_credit' THEN
    UPDATE legacy_x.users SET balance = balance + v_campaign.benefit_value WHERE id = p_user_id RETURNING balance, role INTO v_balance, v_role;
    IF NOT FOUND THEN RAISE EXCEPTION 'Wallet owner was not found' USING ERRCODE = 'P0002'; END IF;
    INSERT INTO legacy_x.wallet_transactions (user_id, type, amount, method, reference_type, reference_id)
    VALUES (p_user_id, 'Charge', v_campaign.benefit_value, 'promo:' || v_code.code_hint, 'promotion_redemption', v_redemption.id)
    RETURNING id INTO v_transaction_id;
    UPDATE legacy_x.promotion_redemptions SET wallet_transaction_id = v_transaction_id WHERE id = v_redemption.id;
  ELSE
    UPDATE legacy_x.users SET role = CASE WHEN role = 'Player' THEN 'Admin' ELSE role END WHERE id = p_user_id RETURNING balance, role INTO v_balance, v_role;
    INSERT INTO legacy_x.user_entitlements (user_id, kind, promotion_redemption_id, granted_role, metadata)
    VALUES (p_user_id, 'admin_role', v_redemption.id, 'Admin', jsonb_build_object('campaignId', v_campaign.id, 'codeHint', v_code.code_hint))
    RETURNING id INTO v_entitlement_id;
  END IF;
  UPDATE legacy_x.promotion_codes SET redemption_count = redemption_count + 1 WHERE id = v_code.id;
  UPDATE legacy_x.promotion_campaigns SET redemption_count = redemption_count + 1, updated_at = now() WHERE id = v_campaign.id;
  INSERT INTO legacy_x.audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('user', p_user_id, 'promotion.redeem', 'promotion_redemption', v_redemption.id, jsonb_build_object('campaignId', v_campaign.id, 'benefitType', v_campaign.benefit_type, 'benefitValue', v_campaign.benefit_value, 'codeHint', v_code.code_hint));
  RETURN jsonb_build_object('redemptionId', v_redemption.id, 'alreadyRedeemed', false, 'benefitType', v_campaign.benefit_type, 'benefitValue', v_campaign.benefit_value, 'balance', v_balance, 'role', v_role, 'entitlementId', v_entitlement_id);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.purchase_store_item_with_promotion(
  p_user_id UUID,
  p_item_id UUID,
  p_code_hash TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_code legacy_x.promotion_codes%ROWTYPE;
  v_campaign legacy_x.promotion_campaigns%ROWTYPE;
  v_price INTEGER;
  v_final_price INTEGER;
  v_used INTEGER;
  v_limit INTEGER;
  v_transaction_id UUID;
  v_purchase_id UUID;
  v_redemption_id UUID;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT store_purchase_id INTO v_purchase_id FROM legacy_x.promotion_redemptions WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF v_purchase_id IS NOT NULL THEN RETURN v_purchase_id; END IF;
  END IF;
  SELECT * INTO v_code FROM legacy_x.promotion_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Promotion code is invalid' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_campaign FROM legacy_x.promotion_campaigns WHERE id = v_code.campaign_id FOR UPDATE;
  IF NOT v_code.is_active OR NOT v_campaign.is_active OR (v_code.starts_at IS NOT NULL AND v_code.starts_at > now()) OR (v_campaign.starts_at IS NOT NULL AND v_campaign.starts_at > now()) OR (v_code.expires_at IS NOT NULL AND v_code.expires_at <= now()) OR (v_campaign.expires_at IS NOT NULL AND v_campaign.expires_at <= now()) THEN RAISE EXCEPTION 'Promotion code is unavailable' USING ERRCODE = 'P0001'; END IF;
  IF v_campaign.benefit_type NOT IN ('store_percent', 'store_fixed') THEN RAISE EXCEPTION 'Promotion code does not apply to store purchases' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.max_redemptions IS NOT NULL AND v_code.redemption_count >= v_code.max_redemptions) OR (v_campaign.max_redemptions IS NOT NULL AND v_campaign.redemption_count >= v_campaign.max_redemptions) THEN RAISE EXCEPTION 'Promotion code usage limit has been reached' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_used FROM legacy_x.promotion_redemptions WHERE code_id = v_code.id AND user_id = p_user_id AND status = 'redeemed';
  v_limit := COALESCE(v_code.per_user_limit, v_campaign.per_user_limit);
  IF v_used >= v_limit THEN RAISE EXCEPTION 'You have already used this promotion code' USING ERRCODE = 'P0001'; END IF;
  SELECT price INTO v_price FROM legacy_x.store_items WHERE id = p_item_id;
  IF v_price IS NULL THEN RAISE EXCEPTION 'Store item was not found' USING ERRCODE = 'P0002'; END IF;
  v_final_price := CASE WHEN v_campaign.benefit_type = 'store_percent' THEN ceil(v_price * GREATEST(0, 100 - v_campaign.benefit_value) / 100.0)::INTEGER ELSE GREATEST(0, v_price - v_campaign.benefit_value) END;
  UPDATE legacy_x.users SET balance = balance - v_final_price WHERE id = p_user_id AND balance >= v_final_price;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient wallet balance or user not found' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO legacy_x.wallet_transactions (user_id, type, amount, method, reference_type) VALUES (p_user_id, 'Purchase', v_final_price, 'promo:' || v_code.code_hint, 'store_purchase') RETURNING id INTO v_transaction_id;
  INSERT INTO legacy_x.store_purchases (user_id, item_id, price_at_purchase, wallet_transaction_id) VALUES (p_user_id, p_item_id, v_final_price, v_transaction_id) RETURNING id INTO v_purchase_id;
  UPDATE legacy_x.wallet_transactions SET reference_id = v_purchase_id WHERE id = v_transaction_id;
  INSERT INTO legacy_x.promotion_redemptions (campaign_id, code_id, user_id, context, benefit_type, benefit_value, code_hint, idempotency_key, store_purchase_id, metadata)
  VALUES (v_campaign.id, v_code.id, p_user_id, 'store_purchase', v_campaign.benefit_type, v_campaign.benefit_value, v_code.code_hint, p_idempotency_key, v_purchase_id, jsonb_build_object('originalPrice', v_price, 'finalPrice', v_final_price)) RETURNING id INTO v_redemption_id;
  UPDATE legacy_x.promotion_codes SET redemption_count = redemption_count + 1 WHERE id = v_code.id;
  UPDATE legacy_x.promotion_campaigns SET redemption_count = redemption_count + 1, updated_at = now() WHERE id = v_campaign.id;
  INSERT INTO legacy_x.audit_logs (actor_type, actor_id, action, target_type, target_id, metadata) VALUES ('user', p_user_id, 'promotion.store_purchase', 'promotion_redemption', v_redemption_id, jsonb_build_object('campaignId', v_campaign.id, 'codeHint', v_code.code_hint, 'discountCoins', v_price - v_final_price));
  RETURN v_purchase_id;
END;
$$;

ALTER TABLE legacy_x.promotion_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.promotion_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.promotion_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.user_entitlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.promotion_campaigns, legacy_x.promotion_codes, legacy_x.promotion_redemptions, legacy_x.user_entitlements FROM anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.quote_promotion_code(UUID, TEXT, TEXT, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION legacy_x.redeem_promotion_code(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION legacy_x.purchase_store_item_with_promotion(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.promotion_campaigns, legacy_x.promotion_codes, legacy_x.promotion_redemptions, legacy_x.user_entitlements TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.quote_promotion_code(UUID, TEXT, TEXT, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.redeem_promotion_code(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.purchase_store_item_with_promotion(UUID, UUID, TEXT, TEXT) TO service_role;

COMMIT;
