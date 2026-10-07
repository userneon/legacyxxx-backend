-- Community skin collections: a player shares a snapshot of their loadout, anyone can apply it.
-- Likes and applies count once per account, and never for the collection's own creator. Only the API (service_role) touches these tables. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.skin_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 40),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 120),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) BETWEEN 1 AND 128),
  item_count integer NOT NULL CHECK (item_count > 0),
  likes_count integer NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  applies_count integer NOT NULL DEFAULT 0 CHECK (applies_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS skin_collections_owner_idx ON legacy_x.skin_collections (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS skin_collections_new_idx ON legacy_x.skin_collections (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS skin_collections_popular_idx ON legacy_x.skin_collections (applies_count DESC, likes_count DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS legacy_x.skin_collection_likes (
  collection_id uuid NOT NULL REFERENCES legacy_x.skin_collections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id)
);
CREATE TABLE IF NOT EXISTS legacy_x.skin_collection_applies (
  collection_id uuid NOT NULL REFERENCES legacy_x.skin_collections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id)
);

ALTER TABLE legacy_x.skin_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skin_collection_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skin_collection_applies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.skin_collections, legacy_x.skin_collection_likes, legacy_x.skin_collection_applies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.skin_collections, legacy_x.skin_collection_likes, legacy_x.skin_collection_applies TO service_role;

-- Sets or takes back a like and keeps the counter in step; returns the new like count. The creator's own like is ignored.
CREATE OR REPLACE FUNCTION legacy_x.skin_collection_set_like(p_collection_id uuid, p_user_id uuid, p_liked boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = legacy_x, public AS $$
DECLARE v_count integer; v_changed integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM legacy_x.skin_collections WHERE id = p_collection_id AND deleted_at IS NULL AND owner_user_id <> p_user_id) THEN
    RAISE EXCEPTION 'Collection is not available to like' USING ERRCODE = 'P0002';
  END IF;
  IF p_liked THEN
    INSERT INTO legacy_x.skin_collection_likes (collection_id, user_id) VALUES (p_collection_id, p_user_id) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM legacy_x.skin_collection_likes WHERE collection_id = p_collection_id AND user_id = p_user_id;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  UPDATE legacy_x.skin_collections
     SET likes_count = (SELECT count(*) FROM legacy_x.skin_collection_likes WHERE collection_id = p_collection_id)
   WHERE id = p_collection_id
   RETURNING likes_count INTO v_count;
  RETURN v_count;
END $$;

-- Counts an apply once per account; the creator's own applies never count. Returns whether it counted.
CREATE OR REPLACE FUNCTION legacy_x.skin_collection_mark_applied(p_collection_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = legacy_x, public AS $$
DECLARE v_inserted integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM legacy_x.skin_collections WHERE id = p_collection_id AND deleted_at IS NULL AND owner_user_id <> p_user_id) THEN
    RETURN false;
  END IF;
  INSERT INTO legacy_x.skin_collection_applies (collection_id, user_id) VALUES (p_collection_id, p_user_id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 1 THEN
    UPDATE legacy_x.skin_collections SET applies_count = applies_count + 1 WHERE id = p_collection_id;
  END IF;
  RETURN v_inserted = 1;
END $$;

REVOKE ALL ON FUNCTION legacy_x.skin_collection_set_like(uuid, uuid, boolean), legacy_x.skin_collection_mark_applied(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.skin_collection_set_like(uuid, uuid, boolean), legacy_x.skin_collection_mark_applied(uuid, uuid) TO service_role;
