-- LEGACY-X Skinchanger static asset origin cleanup.
-- Run only after the latest backend source is deployed. Existing external URLs
-- are retired so browsers never request Akamai/third-party image hosts.
-- Re-run scripts/ingest-skinchanger-catalog.mjs afterwards to repopulate these
-- records with API-owned `skinchanger/catalog/*.webp` object-storage keys.

BEGIN;

UPDATE legacy_x.skinchanger_catalog_items
SET image_key = NULL,
    metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{asset_reingest_required}',
      'true'::jsonb,
      true
    ),
    updated_at = now()
WHERE image_key ~* '^[a-z][a-z0-9+.-]*://';

COMMIT;

-- Verification: must return 0 after cleanup.
-- SELECT id, image_key
-- FROM legacy_x.skinchanger_catalog_items
-- WHERE image_key ~* '^[a-z][a-z0-9+.-]*://'
-- LIMIT 20;
