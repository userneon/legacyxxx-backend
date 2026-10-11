-- LEGACY-X: IP bans live in the same table as SteamID bans, so game servers keep no ban files of their own.
-- A row has a SteamID, an IP address or both. IP-only rows have no penalty record on the website.
ALTER TABLE legacy_x.bans ADD COLUMN IF NOT EXISTS ip_address text;
ALTER TABLE legacy_x.bans ALTER COLUMN steam_id DROP NOT NULL;
ALTER TABLE legacy_x.bans DROP CONSTRAINT IF EXISTS bans_ip_address_check;
ALTER TABLE legacy_x.bans ADD CONSTRAINT bans_ip_address_check CHECK (ip_address IS NULL OR ip_address ~ '^\d{1,3}(\.\d{1,3}){3}$');
ALTER TABLE legacy_x.bans DROP CONSTRAINT IF EXISTS bans_target_check;
ALTER TABLE legacy_x.bans ADD CONSTRAINT bans_target_check CHECK (steam_id IS NOT NULL OR ip_address IS NOT NULL);
CREATE INDEX IF NOT EXISTS bans_active_ip_idx ON legacy_x.bans (ip_address) WHERE ip_address IS NOT NULL AND revoked_at IS NULL;
