-- Applying a shared collection (and saving a whole loadout) failed with "The request was invalid" whenever it held a knife or gloves.
-- Entries of those two slots are keyed per model since legacy_x_skinchanger_entry_mutations.sql ("knife:507", "glove:sport-gloves"),
-- but this bulk function still insisted that a non-weapon slot_key equals its slot. It now accepts "<slot>:<model>" for knife and glove
-- (the plain "knife" / "glove" of older rows stays valid); every other rule is unchanged. Safe to re-run.
CREATE OR REPLACE FUNCTION legacy_x.save_skinchanger_loadout(
  p_user_id UUID,
  p_entries JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_version BIGINT;
BEGIN
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) > 128 THEN
    RAISE EXCEPTION 'Invalid skinchanger loadout entry count' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_entries) AS entry(slot TEXT, slot_key TEXT, team_scope TEXT, catalog_item_id UUID, options JSONB)
    LEFT JOIN legacy_x.skinchanger_catalog_items item ON item.id = entry.catalog_item_id AND item.is_active = true
    WHERE entry.slot NOT IN ('weapon', 'knife', 'glove', 'agent', 'music_kit', 'pin')
      OR entry.slot_key !~ '^[a-z0-9:_-]{1,96}$'
      OR (entry.slot = 'weapon' AND entry.slot_key !~ '^weapon:[a-z0-9_-]+$')
      OR (entry.slot IN ('knife', 'glove') AND entry.slot_key <> entry.slot AND entry.slot_key !~ ('^' || entry.slot || ':[a-z0-9_-]+$'))
      OR (entry.slot NOT IN ('weapon', 'knife', 'glove') AND entry.slot_key <> entry.slot)
      OR entry.team_scope NOT IN ('all', 't', 'ct')
      OR item.id IS NULL
      OR (entry.slot = 'weapon' AND item.category NOT IN ('weapon', 'weapon_skin'))
      OR (entry.slot <> 'weapon' AND item.category <> entry.slot)
  ) THEN
    RAISE EXCEPTION 'Loadout contains an unsupported catalog item' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.skinchanger_loadouts (user_id, version, updated_at)
  VALUES (p_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE
    SET version = legacy_x.skinchanger_loadouts.version + 1,
        updated_at = now()
  RETURNING version INTO v_version;

  DELETE FROM legacy_x.skinchanger_loadout_entries WHERE user_id = p_user_id;

  INSERT INTO legacy_x.skinchanger_loadout_entries (user_id, slot, slot_key, team_scope, catalog_item_id, options, updated_at)
  SELECT
    p_user_id,
    entry.slot,
    entry.slot_key,
    entry.team_scope,
    entry.catalog_item_id,
    COALESCE(entry.options, '{}'::jsonb),
    now()
  FROM jsonb_to_recordset(p_entries) AS entry(slot TEXT, slot_key TEXT, team_scope TEXT, catalog_item_id UUID, options JSONB);

  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION legacy_x.save_skinchanger_loadout(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.save_skinchanger_loadout(UUID, JSONB) TO service_role;
