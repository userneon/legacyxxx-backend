BEGIN;

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
  IF EXISTS (SELECT 1 FROM legacy_x.clan_members WHERE user_id = p_owner_id) THEN
    RAISE EXCEPTION 'User already belongs to a clan' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO legacy_x.clans (name, tag, logo, thumbnail, description, region, max_players, owner_id)
  VALUES (p_name, p_tag, p_logo, p_thumbnail, p_description, p_region, p_max_players, p_owner_id)
  RETURNING id INTO v_clan_id;

  INSERT INTO legacy_x.clan_members (clan_id, user_id, role)
  VALUES (v_clan_id, p_owner_id, 'leader');

  RETURN v_clan_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.join_clan(
  p_user_id UUID,
  p_clan_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_max_players INTEGER;
  v_member_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM legacy_x.clan_members WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'User already belongs to a clan' USING ERRCODE = 'P0001';
  END IF;

  SELECT max_players INTO v_max_players
  FROM legacy_x.clans
  WHERE id = p_clan_id
  FOR UPDATE;

  IF v_max_players IS NULL THEN
    RAISE EXCEPTION 'Clan was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO v_member_count
  FROM legacy_x.clan_members
  WHERE clan_id = p_clan_id;

  IF v_member_count >= v_max_players THEN
    RAISE EXCEPTION 'Clan is full' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO legacy_x.clan_members (clan_id, user_id, role)
  VALUES (p_clan_id, p_user_id, 'member');
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.delete_owned_clan(
  p_owner_id UUID,
  p_clan_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
BEGIN
  DELETE FROM legacy_x.clans
  WHERE id = p_clan_id AND owner_id = p_owner_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Clan was not found or is not owned by this user' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMIT;
