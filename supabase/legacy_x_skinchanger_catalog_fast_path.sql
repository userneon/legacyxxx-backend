-- Sticker, charm, pin and music kit pages were taking 12+ seconds on production (11k stickers): the catalogue page
-- function groups every item by its "browse key" to fold wear variants of one skin together, which for these
-- categories is just the item's own unique external_key, so the grouping (a DISTINCT ON over a regexp-heavy sort
-- that spills to disk) changes nothing. This adds a fast path for them: same columns, same names, same order,
-- same total_count, without the grouping. Every other category runs the original query untouched.
--
-- Rollback: re-apply the previous definition (the body after the fast-path IF block, as a plain LANGUAGE sql function).
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.get_skinchanger_catalog_page(
  p_category text DEFAULT NULL::text,
  p_weapon_class text DEFAULT NULL::text,
  p_weapon_group text DEFAULT NULL::text,
  p_team text DEFAULT NULL::text,
  p_query text DEFAULT NULL::text,
  p_limit integer DEFAULT 36,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(id uuid, external_key text, category text, weapon_class text, display_name text, weapon_defindex integer, paint_id integer, model text, image_key text, metadata jsonb, total_count bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF p_category IN ('sticker', 'charm', 'pin', 'music_kit') AND p_weapon_class IS NULL AND p_weapon_group IS NULL AND p_team IS NULL THEN
    RETURN QUERY
    WITH paged AS (
      SELECT
        item.id,
        item.external_key,
        item.category,
        item.weapon_class,
        regexp_replace(
          regexp_replace(regexp_replace(item.display_name, '^★[[:space:]]*', '', 'i'), '^(StatTrak™\s+|Souvenir\s+)', '', 'i'),
          ' \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$', '', 'i'
        ) AS display_name,
        item.weapon_defindex,
        item.paint_id,
        item.model,
        item.image_key,
        jsonb_set(
          jsonb_set(
            jsonb_set(item.metadata, '{minWear}', to_jsonb(COALESCE(NULLIF(item.metadata ->> 'minWear', '')::NUMERIC, 0.0001)::DOUBLE PRECISION), true),
            '{maxWear}', to_jsonb(COALESCE(NULLIF(item.metadata ->> 'maxWear', '')::NUMERIC, 1)::DOUBLE PRECISION), true
          ),
          '{baseSkinKey}', to_jsonb(item.external_key), true
        ) AS metadata,
        count(*) OVER () AS total_count
      FROM legacy_x.skinchanger_catalog_items item
      WHERE item.is_active = true
        AND item.category = p_category
        AND (p_query IS NULL OR item.display_name ILIKE '%' || p_query || '%' OR item.weapon_class ILIKE '%' || p_query || '%')
    )
    SELECT *
    FROM paged
    ORDER BY
      CASE paged.metadata ->> 'rarity'
        WHEN 'Covert' THEN 1
        WHEN 'Classified' THEN 2
        WHEN 'Restricted' THEN 3
        WHEN 'Mil-Spec Grade' THEN 4
        WHEN 'Industrial Grade' THEN 5
        WHEN 'Consumer Grade' THEN 6
        WHEN 'Contraband' THEN 7
        WHEN 'Extraordinary' THEN 8
        ELSE 99
      END,
      paged.display_name,
      -- Many pins and music kits share a name; a fixed last key keeps page 2 from repeating or skipping page 1's ties.
      paged.external_key
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    OFFSET GREATEST(p_offset, 0);
    RETURN;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT item.*,
      CASE
        WHEN p_category IN ('glove', 'knife') AND p_weapon_class IS NULL THEN p_category || '-type:' || COALESCE(item.weapon_class, item.external_key)
        ELSE legacy_x.skinchanger_catalog_browse_key(item.category, item.weapon_class, item.display_name, item.external_key)
      END AS browse_key,
      (p_category IN ('glove', 'knife') AND p_weapon_class IS NULL) AS model_type_browse
    FROM legacy_x.skinchanger_catalog_items item
    WHERE item.is_active = true
      AND (p_category IS NULL OR item.category = p_category)
      AND (p_weapon_class IS NULL OR item.weapon_class = p_weapon_class)
      AND (
        p_weapon_group IS NULL
        OR item.metadata ->> 'weaponGroup' = p_weapon_group
        OR (p_weapon_group = 'Mid Tier' AND item.metadata ->> 'weaponGroup' IN ('SMGs', 'Heavy'))
      )
      AND (p_category IS DISTINCT FROM 'weapon' OR COALESCE(item.metadata ->> 'weaponGroup', '') IN ('Pistols', 'SMGs', 'Rifles', 'Heavy'))
      AND (p_weapon_class IS NULL OR COALESCE((item.metadata ->> 'baseModel')::BOOLEAN, false) = false)
      AND (p_team IS NULL OR item.metadata ->> 'team' = p_team)
      AND (p_query IS NULL OR item.display_name ILIKE '%' || p_query || '%' OR item.weapon_class ILIKE '%' || p_query || '%')
  ),
  ranges AS (
    SELECT filtered.browse_key,
      min(NULLIF(filtered.metadata ->> 'minWear', '')::NUMERIC) AS min_wear,
      max(NULLIF(filtered.metadata ->> 'maxWear', '')::NUMERIC) AS max_wear
    FROM filtered
    GROUP BY filtered.browse_key
  ),
  grouped AS (
    SELECT DISTINCT ON (filtered.browse_key)
      filtered.*, ranges.min_wear, ranges.max_wear
    FROM filtered
    JOIN ranges USING (browse_key)
    ORDER BY filtered.browse_key,
      CASE WHEN COALESCE((filtered.metadata ->> 'baseModel')::BOOLEAN, false) THEN 0 ELSE 1 END,
      CASE regexp_replace(filtered.display_name, '^.* \(([^)]*)\)$', '\1')
        WHEN 'Factory New' THEN 0
        WHEN 'Minimal Wear' THEN 1
        WHEN 'Field-Tested' THEN 2
        WHEN 'Well-Worn' THEN 3
        WHEN 'Battle-Scarred' THEN 4
        ELSE 5
      END,
      CASE
        WHEN filtered.display_name ~* '^★?[[:space:]]*StatTrak™[[:space:]]+' THEN 1
        WHEN filtered.display_name ~* '^★?[[:space:]]*Souvenir[[:space:]]+' THEN 2
        ELSE 0
      END,
      filtered.display_name
  ),
  paged AS (
    SELECT
      grouped.id,
      grouped.external_key,
      grouped.category,
      grouped.weapon_class,
      CASE
        WHEN grouped.model_type_browse THEN grouped.weapon_class
        ELSE regexp_replace(
          regexp_replace(regexp_replace(grouped.display_name, '^★[[:space:]]*', '', 'i'), '^(StatTrak™\s+|Souvenir\s+)', '', 'i'),
          ' \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$', '', 'i'
        )
      END AS display_name,
      grouped.weapon_defindex,
      grouped.paint_id,
      grouped.model,
      grouped.image_key,
      jsonb_set(
        jsonb_set(
          jsonb_set(grouped.metadata, '{minWear}', to_jsonb(COALESCE(grouped.min_wear, 0.0001)::DOUBLE PRECISION), true),
          '{maxWear}', to_jsonb(COALESCE(grouped.max_wear, 1)::DOUBLE PRECISION), true
        ),
        '{baseSkinKey}', to_jsonb(grouped.browse_key), true
      ) AS metadata,
      count(*) OVER () AS total_count
    FROM grouped
  )
  SELECT *
  FROM paged
  ORDER BY
    CASE paged.metadata ->> 'rarity'
      WHEN 'Covert' THEN 1
      WHEN 'Classified' THEN 2
      WHEN 'Restricted' THEN 3
      WHEN 'Mil-Spec Grade' THEN 4
      WHEN 'Industrial Grade' THEN 5
      WHEN 'Consumer Grade' THEN 6
      WHEN 'Contraband' THEN 7
      WHEN 'Extraordinary' THEN 8
      ELSE 99
    END,
    paged.display_name
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
END;
$function$;

COMMIT;
