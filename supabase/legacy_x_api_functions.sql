BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.ensure_steam_user(
  p_steam_id TEXT,
  p_username TEXT,
  p_avatar TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  INSERT INTO legacy_x.users (steam_id, username, avatar)
  VALUES (
    p_steam_id,
    COALESCE(NULLIF(p_username, ''), 'Steam ' || p_steam_id),
    COALESCE(p_avatar, '')
  )
  ON CONFLICT (steam_id) DO UPDATE
  SET avatar = CASE
    WHEN EXCLUDED.avatar <> '' THEN EXCLUDED.avatar
    ELSE legacy_x.users.avatar
  END
  RETURNING id INTO v_user_id;

  INSERT INTO legacy_x.player_stats (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.create_clan_with_leader(
  p_owner_id UUID,
  p_name TEXT,
  p_tag TEXT,
  p_logo TEXT,
  p_thumbnail TEXT,
  p_description TEXT,
  p_region TEXT,
  p_max_players INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_clan_id UUID;
BEGIN
  INSERT INTO legacy_x.clans (name, tag, logo, thumbnail, description, region, max_players, owner_id)
  VALUES (p_name, p_tag, p_logo, p_thumbnail, p_description, p_region, p_max_players, p_owner_id)
  RETURNING id INTO v_clan_id;

  INSERT INTO legacy_x.clan_members (clan_id, user_id, role)
  VALUES (v_clan_id, p_owner_id, 'leader');

  RETURN v_clan_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.purchase_store_item(
  p_user_id UUID,
  p_item_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_price INTEGER;
  v_wallet_transaction_id UUID;
  v_purchase_id UUID;
BEGIN
  SELECT price INTO v_price
  FROM legacy_x.store_items
  WHERE id = p_item_id;

  IF v_price IS NULL THEN
    RAISE EXCEPTION 'Store item was not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE legacy_x.users
  SET balance = balance - v_price
  WHERE id = p_user_id AND balance >= v_price;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient wallet balance or user not found' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO legacy_x.wallet_transactions (user_id, type, amount, method, reference_type)
  VALUES (p_user_id, 'Purchase', v_price, '', 'store_purchase')
  RETURNING id INTO v_wallet_transaction_id;

  INSERT INTO legacy_x.store_purchases (user_id, item_id, price_at_purchase, wallet_transaction_id)
  VALUES (p_user_id, p_item_id, v_price, v_wallet_transaction_id)
  RETURNING id INTO v_purchase_id;

  UPDATE legacy_x.wallet_transactions
  SET reference_id = v_purchase_id
  WHERE id = v_wallet_transaction_id;

  RETURN v_purchase_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.credit_wallet(
  p_user_id UUID,
  p_amount INTEGER,
  p_method TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_transaction_id UUID;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Charge amount must be positive' USING ERRCODE = '22023';
  END IF;

  UPDATE legacy_x.users
  SET balance = balance + p_amount
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet owner was not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO legacy_x.wallet_transactions (user_id, type, amount, method, reference_type)
  VALUES (p_user_id, 'Charge', p_amount, p_method, 'wallet_charge')
  RETURNING id INTO v_transaction_id;

  RETURN v_transaction_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.plugin_write_community_content(
  p_plugin_id UUID,
  p_kind TEXT,
  p_name TEXT,
  p_handle TEXT,
  p_description TEXT,
  p_partner_type TEXT,
  p_url TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_content_id UUID;
  v_action TEXT;
BEGIN
  IF p_kind = 'creator' THEN
    INSERT INTO legacy_x.community_creators (name, handle, url, created_by, created_by_id)
    VALUES (p_name, COALESCE(p_handle, ''), p_url, 'plugin', p_plugin_id)
    ON CONFLICT (url) DO UPDATE
    SET name = EXCLUDED.name,
        handle = EXCLUDED.handle,
        created_by = 'plugin',
        created_by_id = p_plugin_id
    RETURNING id INTO v_content_id;
    v_action := 'community.creator.upsert';
  ELSIF p_kind = 'partner' THEN
    INSERT INTO legacy_x.community_partners (name, description, type, url, created_by, created_by_id)
    VALUES (p_name, COALESCE(p_description, ''), p_partner_type::legacy_x.community_partner_type, p_url, 'plugin', p_plugin_id)
    ON CONFLICT (url) DO UPDATE
    SET name = EXCLUDED.name,
        description = EXCLUDED.description,
        type = EXCLUDED.type,
        created_by = 'plugin',
        created_by_id = p_plugin_id
    RETURNING id INTO v_content_id;
    v_action := 'community.partner.upsert';
  ELSE
    RAISE EXCEPTION 'Unsupported community content kind' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, v_action, p_kind, v_content_id, jsonb_build_object('url', p_url));

  RETURN v_content_id;
END;
$$;

COMMIT;
