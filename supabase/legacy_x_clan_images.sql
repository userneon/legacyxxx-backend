-- Clan pictures: one logo (PNG) and one banner (PNG, JPEG or GIF) per clan. The bytes live here, are checked by the API
-- before they are stored, and are served back by GET /clans/:id/logo|banner. Only the API (service_role) touches the table.

CREATE TABLE IF NOT EXISTS legacy_x.clan_images (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('logo', 'banner')),
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif')),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 1048576),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, kind)
);
ALTER TABLE legacy_x.clan_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_images FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_images TO service_role;
