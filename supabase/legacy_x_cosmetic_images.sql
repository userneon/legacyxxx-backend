-- Pictures of cosmetic items (owner request 2026-11-21): one place for the picture of every weapon model (and any other item), instead of a file per item in the website.
-- Staff put a picture on an item once (Staff → Shop → Cosmetics); the API serves it at GET /api/v1/cosmetics/:id/image and sends its address as `image` with the item.
-- Additive only: a new table and one empty column. Safe to re-run.

ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS image_v bigint;

CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_images (
  item_id text PRIMARY KEY REFERENCES legacy_x.cosmetic_items(id) ON DELETE CASCADE,
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 2097152),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.cosmetic_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.cosmetic_images FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.cosmetic_images TO service_role;
