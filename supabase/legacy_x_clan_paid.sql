-- Clans, part 2: creating a clan costs coins and needs some ranked matches played. The fee, the clan row and the
-- leader's membership happen in one transaction, so a taken name or tag never costs anything. Safe to re-run.

CREATE OR REPLACE FUNCTION legacy_x.create_clan_paid(
  p_owner_id uuid, p_name text, p_tag text, p_region text, p_fee integer, p_min_matches integer, p_welcome integer DEFAULT 0
) RETURNS uuid
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  v_matches integer;
  v_clan_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM legacy_x.clan_members WHERE user_id = p_owner_id) THEN
    RAISE EXCEPTION 'User already belongs to a clan' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(max(matches_completed), 0) INTO v_matches FROM legacy_x.competitive_player_progression WHERE user_id = p_owner_id;
  IF v_matches < p_min_matches THEN
    RAISE EXCEPTION 'Play % more ranked matches to create a clan', p_min_matches - v_matches USING ERRCODE = 'P0001';
  END IF;
  PERFORM legacy_x.wallet_ensure(p_owner_id, p_welcome);
  PERFORM legacy_x.wallet_apply(p_owner_id, -p_fee, 'spend', 'Clan created: ' || p_name, NULL, p_owner_id);
  INSERT INTO legacy_x.clans (name, tag, logo, description, region, max_players, owner_id)
  VALUES (p_name, p_tag, '', NULL, p_region, 10, p_owner_id) RETURNING id INTO v_clan_id;
  INSERT INTO legacy_x.clan_members (clan_id, user_id, role) VALUES (v_clan_id, p_owner_id, 'leader');
  RETURN v_clan_id;
END $$;

REVOKE ALL ON FUNCTION legacy_x.create_clan_paid(uuid, text, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.create_clan_paid(uuid, text, text, text, integer, integer, integer) TO service_role;
