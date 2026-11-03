-- A match did not start on the site when one of its players had the same in-game name as another account: users.username is unique, and
-- ingest_core_match_event wrote the in-game name into it (INSERT ... ON CONFLICT (steam_id) DO UPDATE SET username), so the whole
-- match_created failed with 23505 (HTTP 409) and nothing was saved: no match, no result, no EXP (2026-11-03, 2v2 matches).
-- Now the player is found or made by Steam ID; their name is only changed when it is free, and a taken name gets the last digits of the Steam ID.
-- Safe to re-run.
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.match_user_for(p_steam_id text, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $$
DECLARE
  v_id uuid;
  v_name text := left(COALESCE(NULLIF(btrim(p_name), ''), 'Steam ' || p_steam_id), 60);
  v_alt text := left(v_name, 48) || ' #' || right(p_steam_id, 4);
BEGIN
  SELECT id INTO v_id FROM legacy_x.users WHERE steam_id = p_steam_id;
  IF v_id IS NULL THEN
    BEGIN
      INSERT INTO legacy_x.users (steam_id, username, avatar) VALUES (p_steam_id, v_name, '') RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO v_id FROM legacy_x.users WHERE steam_id = p_steam_id;
      IF v_id IS NULL THEN
        INSERT INTO legacy_x.users (steam_id, username, avatar) VALUES (p_steam_id, v_alt, '') RETURNING id INTO v_id;
      END IF;
    END;
    RETURN v_id;
  END IF;
  BEGIN
    UPDATE legacy_x.users SET username = v_name WHERE id = v_id AND username <> v_name;
  EXCEPTION WHEN unique_violation THEN
    NULL; -- the name belongs to another account: the player keeps the one they have
  END;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION legacy_x.match_user_for(text, text) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'legacy_x' AND p.proname = 'ingest_core_match_event';
  v_def := regexp_replace(v_def,
    'INSERT INTO legacy_x\.users \(steam_id, username, avatar\)\s+VALUES \(v_steam_id, COALESCE\(NULLIF\(v_player->>''name'', ''''\), ''Steam '' \|\| v_steam_id\), ''''\)\s+ON CONFLICT \(steam_id\) DO UPDATE SET username = EXCLUDED\.username\s+RETURNING id INTO v_user_id;',
    'v_user_id := legacy_x.match_user_for(v_steam_id, v_player->>''name'');');
  v_def := regexp_replace(v_def,
    'INSERT INTO legacy_x\.users \(steam_id, username, avatar\) VALUES \(v_steam_id, COALESCE\(NULLIF\(p_payload->>''name'', ''''\), ''Steam '' \|\| v_steam_id\), ''''\) ON CONFLICT \(steam_id\) DO UPDATE SET username = EXCLUDED\.username RETURNING id INTO v_user_id;',
    'v_user_id := legacy_x.match_user_for(v_steam_id, p_payload->>''name'');');
  IF v_def NOT LIKE '%match_user_for(v_steam_id, v_player%' OR v_def NOT LIKE '%match_user_for(v_steam_id, p_payload%' THEN
    RAISE EXCEPTION 'ingest_core_match_event has changed: patch it by hand';
  END IF;
  EXECUTE v_def;
END $$;

COMMIT;
