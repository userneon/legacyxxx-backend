-- Additive, data-preserving Skinchanger entry mutations.
-- Deploy the matching Root API and frontend before any optional legacy-key rekey.
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.upsert_skinchanger_loadout_entry(
  p_user_id UUID,
  p_expected_version BIGINT,
  p_entry JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_current_version BIGINT;
  v_next_version BIGINT;
  v_slot TEXT;
  v_slot_key TEXT;
  v_team_scope TEXT;
  v_catalog_item_id UUID;
  v_options JSONB;
  v_category TEXT;
  v_weapon_class TEXT;
  v_weapon_defindex INTEGER;
  v_display_name TEXT;
  v_metadata JSONB;
  v_required_scope TEXT := 'all';
  v_model_key TEXT;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 OR jsonb_typeof(p_entry) <> 'object' THEN
    RAISE EXCEPTION 'Invalid Skinchanger entry mutation' USING ERRCODE = '22023';
  END IF;

  SELECT entry.slot, entry.slot_key, entry.team_scope, entry.catalog_item_id, COALESCE(entry.options, '{}'::JSONB)
    INTO v_slot, v_slot_key, v_team_scope, v_catalog_item_id, v_options
  FROM jsonb_to_record(p_entry) AS entry(slot TEXT, slot_key TEXT, team_scope TEXT, catalog_item_id UUID, options JSONB);

  IF v_slot NOT IN ('weapon', 'knife', 'glove', 'agent', 'music_kit', 'pin')
     OR v_slot_key !~ '^[a-z0-9:_-]{1,96}$'
     OR v_team_scope NOT IN ('all', 't', 'ct')
     OR jsonb_typeof(v_options) <> 'object' THEN
    RAISE EXCEPTION 'Invalid Skinchanger entry shape' USING ERRCODE = '22023';
  END IF;

  SELECT category, weapon_class, weapon_defindex, display_name, metadata
    INTO v_category, v_weapon_class, v_weapon_defindex, v_display_name, v_metadata
  FROM legacy_x.skinchanger_catalog_items
  WHERE id = v_catalog_item_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected Skinchanger item is unavailable' USING ERRCODE = 'P0002';
  END IF;

  IF (v_slot = 'weapon' AND v_category NOT IN ('weapon', 'weapon_skin'))
     OR (v_slot <> 'weapon' AND v_category <> v_slot) THEN
    RAISE EXCEPTION 'Selected Skinchanger item does not match slot' USING ERRCODE = '22023';
  END IF;

  v_model_key := regexp_replace(lower(COALESCE(v_weapon_defindex::TEXT, v_weapon_class, v_display_name, v_catalog_item_id::TEXT)), '[^a-z0-9_-]+', '-', 'g');
  IF (v_slot = 'weapon' AND v_slot_key <> ('weapon:' || v_model_key))
     OR (v_slot IN ('knife', 'glove') AND v_slot_key <> (v_slot || ':' || v_model_key))
     OR (v_slot NOT IN ('weapon', 'knife', 'glove') AND v_slot_key <> v_slot) THEN
    RAISE EXCEPTION 'Skinchanger slot key does not match selected model' USING ERRCODE = '22023';
  END IF;

  IF lower(COALESCE(v_metadata ->> 'team', '')) = 'terrorist'
     OR (v_slot = 'weapon' AND v_weapon_class IN ('AK-47', 'Galil AR', 'SG 553', 'G3SG1', 'Glock-18', 'Tec-9', 'MAC-10', 'Sawed-Off')) THEN
    v_required_scope := 't';
  ELSIF lower(COALESCE(v_metadata ->> 'team', '')) = 'counter-terrorist'
     OR (v_slot = 'weapon' AND v_weapon_class IN ('AUG', 'FAMAS', 'M4A1-S', 'M4A4', 'SCAR-20', 'USP-S', 'P2000', 'Five-SeveN', 'MP9', 'MAG-7')) THEN
    v_required_scope := 'ct';
  END IF;
  IF v_required_scope <> 'all' AND v_team_scope <> v_required_scope THEN
    RAISE EXCEPTION 'Selected Skinchanger item is limited to one team' USING ERRCODE = '22023';
  END IF;

  IF v_slot <> 'weapon' AND ((v_options ? 'stickers' AND COALESCE(jsonb_array_length(v_options -> 'stickers'), 0) > 0) OR v_options ? 'charm') THEN
    RAISE EXCEPTION 'Only weapon entries may include stickers or a charm' USING ERRCODE = '22023';
  END IF;
  IF v_options ? 'stickers' THEN
    IF jsonb_typeof(v_options -> 'stickers') <> 'array' OR jsonb_array_length(v_options -> 'stickers') > 5 THEN
      RAISE EXCEPTION 'Invalid Skinchanger sticker list' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_options -> 'stickers') AS sticker(value)
      LEFT JOIN legacy_x.skinchanger_catalog_items item ON item.id = NULLIF(sticker.value ->> 'catalogItemId', '')::UUID AND item.is_active = true
      WHERE jsonb_typeof(sticker.value) <> 'object'
         OR item.id IS NULL
         OR item.category <> 'sticker'
         OR item.weapon_defindex IS NULL
         OR NULLIF(sticker.value ->> 'slot', '')::INTEGER NOT BETWEEN 0 AND 4
    ) THEN
      RAISE EXCEPTION 'Invalid Skinchanger sticker selection' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_options -> 'stickers') AS sticker(value)
      GROUP BY sticker.value ->> 'slot' HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'Skinchanger sticker slots must be unique' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_options ? 'charm' THEN
    IF jsonb_typeof(v_options -> 'charm') <> 'object' OR NOT EXISTS (
      SELECT 1 FROM legacy_x.skinchanger_catalog_items item
      WHERE item.id = NULLIF(v_options -> 'charm' ->> 'catalogItemId', '')::UUID
        AND item.is_active = true AND item.category = 'charm' AND item.weapon_defindex IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Invalid Skinchanger charm selection' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO legacy_x.skinchanger_loadouts (user_id, version, updated_at)
  VALUES (p_user_id, 0, now())
  ON CONFLICT (user_id) DO NOTHING;
  SELECT version INTO v_current_version
  FROM legacy_x.skinchanger_loadouts
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Skinchanger loadout version conflict' USING ERRCODE = 'P0001';
  END IF;

  -- Preserve old generic keys during the staged rollout, but replace the old
  -- record for this exact knife/glove type to prevent duplicate application.
  IF v_slot IN ('knife', 'glove') THEN
    DELETE FROM legacy_x.skinchanger_loadout_entries entry
    USING legacy_x.skinchanger_catalog_items existing_item
    WHERE entry.user_id = p_user_id
      AND entry.slot = v_slot
      AND entry.slot_key = v_slot
      AND entry.team_scope = v_team_scope
      AND existing_item.id = entry.catalog_item_id
      AND existing_item.weapon_class = v_weapon_class;
  END IF;

  INSERT INTO legacy_x.skinchanger_loadout_entries (user_id, slot, slot_key, team_scope, catalog_item_id, options, updated_at)
  VALUES (p_user_id, v_slot, v_slot_key, v_team_scope, v_catalog_item_id, v_options, now())
  ON CONFLICT (user_id, slot_key, team_scope) DO UPDATE
    SET slot = EXCLUDED.slot,
        catalog_item_id = EXCLUDED.catalog_item_id,
        options = EXCLUDED.options,
        updated_at = now();

  UPDATE legacy_x.skinchanger_loadouts
  SET version = v_current_version + 1, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING version INTO v_next_version;
  RETURN jsonb_build_object('version', v_next_version);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.delete_skinchanger_loadout_entry(
  p_user_id UUID,
  p_expected_version BIGINT,
  p_slot_key TEXT,
  p_team_scope TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_current_version BIGINT;
  v_next_version BIGINT;
  v_removed INTEGER;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_slot_key !~ '^[a-z0-9:_-]{1,96}$' OR p_team_scope NOT IN ('all', 't', 'ct') THEN
    RAISE EXCEPTION 'Invalid Skinchanger entry deletion' USING ERRCODE = '22023';
  END IF;
  SELECT version INTO v_current_version
  FROM legacy_x.skinchanger_loadouts
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Skinchanger loadout is unavailable' USING ERRCODE = 'P0002';
  END IF;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Skinchanger loadout version conflict' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM legacy_x.skinchanger_loadout_entries
  WHERE user_id = p_user_id AND slot_key = p_slot_key AND team_scope = p_team_scope;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  IF v_removed <> 1 THEN
    RAISE EXCEPTION 'Skinchanger loadout entry was not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE legacy_x.skinchanger_loadouts
  SET version = v_current_version + 1, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING version INTO v_next_version;
  RETURN jsonb_build_object('version', v_next_version, 'removed', true);
END;
$$;

REVOKE ALL ON FUNCTION legacy_x.upsert_skinchanger_loadout_entry(UUID, BIGINT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.delete_skinchanger_loadout_entry(UUID, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.upsert_skinchanger_loadout_entry(UUID, BIGINT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.delete_skinchanger_loadout_entry(UUID, BIGINT, TEXT, TEXT) TO service_role;

COMMIT;
