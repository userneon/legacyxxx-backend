-- Slot count and GOTV address from the reconnect heartbeat, for the Play page capacity bars and Spectate.
-- Applied to production as migration 20260924075113; kept here verbatim.
ALTER TABLE legacy_x.reconnect_servers
  ADD COLUMN IF NOT EXISTS max_players integer CHECK (max_players IS NULL OR max_players BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS gotv_address text CHECK (gotv_address IS NULL OR char_length(gotv_address) <= 255);
COMMENT ON COLUMN legacy_x.reconnect_servers.max_players IS 'Server slot count from the reconnect plugin heartbeat (Server.MaxPlayers).';
COMMENT ON COLUMN legacy_x.reconnect_servers.gotv_address IS 'Optional GOTV address (LEGACYX_GOTV_ADDRESS) for Spectate on the Play page.';
