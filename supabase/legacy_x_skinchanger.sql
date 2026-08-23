BEGIN;

CREATE SCHEMA IF NOT EXISTS legacy_x;

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('weapon', 'weapon_skin', 'knife', 'glove', 'agent', 'music_kit', 'pin', 'sticker', 'charm')),
  weapon_class TEXT,
  display_name TEXT NOT NULL,
  weapon_defindex INTEGER,
  paint_id INTEGER,
  model TEXT,
  image_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skinchanger_catalog_browse_idx
  ON legacy_x.skinchanger_catalog_items (category, weapon_class, display_name)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION legacy_x.skinchanger_catalog_browse_key(
  p_category TEXT,
  p_weapon_class TEXT,
  p_display_name TEXT,
  p_external_key TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_category IN ('weapon_skin', 'knife', 'glove') THEN
      COALESCE(p_weapon_class, '') || ':' || regexp_replace(
        regexp_replace(p_display_name, '^(StatTrak™\s+|Souvenir\s+)', '', 'i'),
        ' \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$', '', 'i'
      )
    ELSE p_external_key
  END
$$;

CREATE OR REPLACE FUNCTION legacy_x.get_skinchanger_catalog_page(
  p_category TEXT DEFAULT NULL,
  p_weapon_class TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 36,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  external_key TEXT,
  category TEXT,
  weapon_class TEXT,
  display_name TEXT,
  weapon_defindex INTEGER,
  paint_id INTEGER,
  model TEXT,
  image_key TEXT,
  metadata JSONB,
  total_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
  WITH filtered AS (
    SELECT item.*,
      legacy_x.skinchanger_catalog_browse_key(item.category, item.weapon_class, item.display_name, item.external_key) AS browse_key
    FROM legacy_x.skinchanger_catalog_items item
    WHERE item.is_active = true
      AND (p_category IS NULL OR item.category = p_category)
      AND (p_weapon_class IS NULL OR item.weapon_class = p_weapon_class)
      AND (p_query IS NULL OR item.display_name ILIKE '%' || p_query || '%')
  ),
  ranges AS (
    SELECT browse_key,
      min(NULLIF(metadata ->> 'minWear', '')::NUMERIC) AS min_wear,
      max(NULLIF(metadata ->> 'maxWear', '')::NUMERIC) AS max_wear
    FROM filtered
    GROUP BY browse_key
  ),
  grouped AS (
    SELECT DISTINCT ON (browse_key)
      filtered.*, ranges.min_wear, ranges.max_wear
    FROM filtered
    JOIN ranges USING (browse_key)
    ORDER BY browse_key,
      CASE regexp_replace(display_name, '^.* \(([^)]*)\)$', '\1')
        WHEN 'Factory New' THEN 0
        WHEN 'Minimal Wear' THEN 1
        WHEN 'Field-Tested' THEN 2
        WHEN 'Well-Worn' THEN 3
        WHEN 'Battle-Scarred' THEN 4
        ELSE 5
      END,
      CASE WHEN display_name ~* '^StatTrak™\s+' THEN 1 WHEN display_name ~* '^Souvenir\s+' THEN 2 ELSE 0 END,
      display_name
  ),
  paged AS (
    SELECT
      id,
      external_key,
      category,
      weapon_class,
      regexp_replace(
        regexp_replace(display_name, '^(StatTrak™\s+|Souvenir\s+)', '', 'i'),
        ' \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$', '', 'i'
      ) AS display_name,
      weapon_defindex,
      paint_id,
      model,
      image_key,
      jsonb_set(
        jsonb_set(
          jsonb_set(metadata, '{minWear}', to_jsonb(COALESCE(min_wear, 0.0001)::DOUBLE PRECISION), true),
          '{maxWear}', to_jsonb(COALESCE(max_wear, 1)::DOUBLE PRECISION), true
        ),
        '{baseSkinKey}', to_jsonb(browse_key), true
      ) AS metadata,
      count(*) OVER () AS total_count
    FROM grouped
  )
  SELECT *
  FROM paged
  ORDER BY display_name
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0)
$$;

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_loadouts (
  user_id UUID PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_loadout_entries (
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('weapon', 'knife', 'glove', 'agent', 'music_kit', 'pin')),
  slot_key TEXT NOT NULL CHECK (slot_key ~ '^[a-z0-9:_-]{1,96}$'),
  team_scope TEXT NOT NULL DEFAULT 'all' CHECK (team_scope IN ('all', 't', 'ct')),
  catalog_item_id UUID NOT NULL REFERENCES legacy_x.skinchanger_catalog_items(id) ON DELETE RESTRICT,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot_key, team_scope)
);

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_server_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id TEXT NOT NULL,
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  player_name TEXT NOT NULL DEFAULT '',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS skinchanger_active_session_idx
  ON legacy_x.skinchanger_server_sessions (server_id, steam_id)
  WHERE disconnected_at IS NULL;
CREATE INDEX IF NOT EXISTS skinchanger_active_user_idx
  ON legacy_x.skinchanger_server_sessions (user_id, last_seen_at DESC)
  WHERE disconnected_at IS NULL;

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_apply_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  server_id TEXT NOT NULL,
  loadout_version BIGINT NOT NULL CHECK (loadout_version >= 0),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'applied', 'failed', 'cancelled')),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failure_code TEXT,
  failure_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skinchanger_jobs_queue_idx
  ON legacy_x.skinchanger_apply_jobs (server_id, status, created_at)
  WHERE status IN ('queued', 'leased');
CREATE INDEX IF NOT EXISTS skinchanger_jobs_user_idx
  ON legacy_x.skinchanger_apply_jobs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_plugin_receipts (
  event_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('session_connected', 'session_heartbeat', 'session_disconnected', 'job_ack')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
      OR (entry.slot <> 'weapon' AND entry.slot_key <> entry.slot)
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

CREATE OR REPLACE FUNCTION legacy_x.get_skinchanger_catalog_facets(
  p_category TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
  SELECT jsonb_build_object(
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category', category, 'count', item_count) ORDER BY category)
      FROM (
        SELECT category, count(DISTINCT legacy_x.skinchanger_catalog_browse_key(category, weapon_class, display_name, external_key))::INTEGER AS item_count
        FROM legacy_x.skinchanger_catalog_items
        WHERE is_active = true
        GROUP BY category
      ) category_counts
    ), '[]'::jsonb),
    'weaponClasses', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('weaponClass', weapon_class, 'count', item_count) ORDER BY weapon_class)
      FROM (
        SELECT weapon_class, count(DISTINCT legacy_x.skinchanger_catalog_browse_key(category, weapon_class, display_name, external_key))::INTEGER AS item_count
        FROM legacy_x.skinchanger_catalog_items
        WHERE is_active = true
          AND weapon_class IS NOT NULL
          AND weapon_class <> ''
          AND (p_category IS NULL OR category = p_category)
        GROUP BY weapon_class
      ) class_counts
    ), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION legacy_x.queue_skinchanger_apply(
  p_user_id UUID,
  p_server_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_steam_id TEXT;
  v_version BIGINT;
  v_payload JSONB;
  v_job_id UUID;
BEGIN
  SELECT steam_id INTO v_steam_id FROM legacy_x.users WHERE id = p_user_id;
  SELECT version INTO v_version FROM legacy_x.skinchanger_loadouts WHERE user_id = p_user_id;
  IF v_steam_id IS NULL OR v_version IS NULL THEN
    RAISE EXCEPTION 'Skinchanger loadout is not available' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM legacy_x.skinchanger_server_sessions
    WHERE user_id = p_user_id AND server_id = p_server_id AND disconnected_at IS NULL
      AND last_seen_at >= now() - interval '90 seconds'
  ) THEN
    RAISE EXCEPTION 'Player is not active on the selected server' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_build_object(
    'version', v_version,
    'entries', COALESCE(jsonb_agg(jsonb_build_object(
      'slot', entry.slot,
      'slotKey', entry.slot_key,
      'teamScope', entry.team_scope,
      'catalogItemId', item.id,
      'category', item.category,
      'weaponDefindex', item.weapon_defindex,
      'paintId', item.paint_id,
      'model', item.model,
      'options', entry.options
    ) ORDER BY entry.slot, entry.slot_key, entry.team_scope), '[]'::jsonb)
  )
  INTO v_payload
  FROM legacy_x.skinchanger_loadout_entries entry
  JOIN legacy_x.skinchanger_catalog_items item ON item.id = entry.catalog_item_id
  WHERE entry.user_id = p_user_id;

  UPDATE legacy_x.skinchanger_apply_jobs
  SET status = 'cancelled', updated_at = now()
  WHERE user_id = p_user_id AND server_id = p_server_id AND status IN ('queued', 'leased');

  INSERT INTO legacy_x.skinchanger_apply_jobs (user_id, steam_id, server_id, loadout_version, payload)
  VALUES (p_user_id, v_steam_id, p_server_id, v_version, COALESCE(v_payload, jsonb_build_object('version', v_version, 'entries', '[]'::jsonb)))
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.claim_skinchanger_apply_jobs(
  p_server_id TEXT,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  steam_id TEXT,
  loadout_version BIGINT,
  payload JSONB,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Invalid claim limit' USING ERRCODE = '22023';
  END IF;

  UPDATE legacy_x.skinchanger_apply_jobs
  SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE server_id = p_server_id AND status = 'leased' AND lease_expires_at <= now();

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM legacy_x.skinchanger_apply_jobs job
    WHERE job.server_id = p_server_id AND job.status = 'queued'
    ORDER BY job.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE legacy_x.skinchanger_apply_jobs job
  SET status = 'leased',
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '30 seconds',
      attempts = job.attempts + 1,
      updated_at = now()
  FROM candidates
  WHERE job.id = candidates.id
  RETURNING job.id, job.steam_id, job.loadout_version, job.payload, job.lease_token, job.lease_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ack_skinchanger_apply(
  p_job_id UUID,
  p_lease_token UUID,
  p_status TEXT,
  p_failure_code TEXT DEFAULT NULL,
  p_failure_detail TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_updated UUID;
BEGIN
  IF p_status NOT IN ('applied', 'failed') THEN
    RAISE EXCEPTION 'Invalid job acknowledgement status' USING ERRCODE = '22023';
  END IF;

  UPDATE legacy_x.skinchanger_apply_jobs
  SET status = p_status,
      lease_expires_at = NULL,
      failure_code = CASE WHEN p_status = 'failed' THEN left(COALESCE(p_failure_code, 'apply_failed'), 64) ELSE NULL END,
      failure_detail = CASE WHEN p_status = 'failed' THEN left(COALESCE(p_failure_detail, ''), 256) ELSE NULL END,
      applied_at = CASE WHEN p_status = 'applied' THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_job_id AND status = 'leased' AND lease_token = p_lease_token
  RETURNING id INTO v_updated;

  IF v_updated IS NULL THEN
    RAISE EXCEPTION 'Job lease is invalid or expired' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('status', p_status, 'jobId', v_updated);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_skinchanger_session(
  p_event_id TEXT,
  p_plugin_id TEXT,
  p_event_type TEXT,
  p_server_id TEXT,
  p_steam_id TEXT,
  p_player_name TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_user_id UUID;
  v_inserted BOOLEAN;
BEGIN
  IF p_event_type NOT IN ('session_connected', 'session_heartbeat', 'session_disconnected') THEN
    RAISE EXCEPTION 'Unsupported skinchanger session event' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.skinchanger_plugin_receipts (event_id, plugin_id, event_type)
  VALUES (p_event_id, p_plugin_id, p_event_type)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO v_inserted;
  IF NOT COALESCE(v_inserted, false) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  SELECT id INTO v_user_id FROM legacy_x.users WHERE steam_id = p_steam_id;
  IF p_event_type = 'session_disconnected' THEN
    UPDATE legacy_x.skinchanger_server_sessions
    SET disconnected_at = COALESCE(disconnected_at, now()), updated_at = now()
    WHERE server_id = p_server_id AND steam_id = p_steam_id AND disconnected_at IS NULL;
  ELSE
    INSERT INTO legacy_x.skinchanger_server_sessions (server_id, steam_id, user_id, player_name, last_seen_at)
    VALUES (p_server_id, p_steam_id, v_user_id, left(COALESCE(p_player_name, ''), 128), now())
    ON CONFLICT (server_id, steam_id) WHERE disconnected_at IS NULL DO UPDATE
    SET user_id = EXCLUDED.user_id,
        player_name = EXCLUDED.player_name,
        last_seen_at = now(),
        updated_at = now();
  END IF;

  RETURN jsonb_build_object('status', 'accepted', 'userId', v_user_id);
END;
$$;

ALTER TABLE legacy_x.skinchanger_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_loadouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_loadout_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_server_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_apply_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_plugin_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON legacy_x.skinchanger_catalog_items, legacy_x.skinchanger_loadouts, legacy_x.skinchanger_loadout_entries, legacy_x.skinchanger_server_sessions, legacy_x.skinchanger_apply_jobs, legacy_x.skinchanger_plugin_receipts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.skinchanger_catalog_items, legacy_x.skinchanger_loadouts, legacy_x.skinchanger_loadout_entries, legacy_x.skinchanger_server_sessions, legacy_x.skinchanger_apply_jobs, legacy_x.skinchanger_plugin_receipts TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.save_skinchanger_loadout(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.get_skinchanger_catalog_facets() TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.queue_skinchanger_apply(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.claim_skinchanger_apply_jobs(TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ack_skinchanger_apply(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_skinchanger_session(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
