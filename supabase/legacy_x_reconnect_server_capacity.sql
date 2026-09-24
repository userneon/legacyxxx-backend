-- Play pages: real slot counts and optional GOTV address per server, reported by the
-- LegacyX-Reconnect heartbeat (max_players = Server.MaxPlayers, gotv_address = LEGACYX_GOTV_ADDRESS).
-- Both are nullable: older plugins keep working and the site falls back to 10 slots / no Spectate.
BEGIN;

ALTER TABLE legacy_x.reconnect_servers
  ADD COLUMN IF NOT EXISTS max_players integer CHECK (max_players IS NULL OR max_players BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS gotv_address text CHECK (gotv_address IS NULL OR char_length(gotv_address) <= 255);
COMMENT ON COLUMN legacy_x.reconnect_servers.max_players IS 'Server slot count from the reconnect plugin heartbeat (Server.MaxPlayers).';
COMMENT ON COLUMN legacy_x.reconnect_servers.gotv_address IS 'Optional GOTV address (LEGACYX_GOTV_ADDRESS) for Spectate on the Play page.';

COMMIT;
