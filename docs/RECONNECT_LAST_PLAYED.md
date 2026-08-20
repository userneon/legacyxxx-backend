# LEGACY-X Reconnect & Last Played

## Scope

Reconnect solves accidental disconnect and server discovery without letting a player inject a destination address. The CounterStrikeSharp plugin records an authenticated session when a player fully connects, closes it on disconnect, and emits an availability heartbeat every 30 seconds. The backend stores the latest three private sessions and marks them reconnectable only if their server sent a heartbeat within 90 seconds and the reconnect window has not expired.

## Security model

`RECONNECT_SERVER_REGISTRY` is an explicit server-ID to connect-address allowlist. The backend rejects any plugin event whose ID or address does not exactly match it. `css_reconnect` asks the backend for a last-played session on a different server, accepts only an online/reconnectable session, validates the returned `host:port` shape again, then uses that address. No chat argument, public profile field, or client-provided URL can become a reconnect target.

## Privacy

Reconnect history and current server state are private by default. The API exposes them only through the operator API or a plugin-authenticated endpoint that is scoped to `legacyx-reconnect`. Do not add a public presence page until a separate player visibility preference has been designed and implemented.

## Installation

1. Apply `legacy_x_reconnect.sql` after the existing admin/rank/community migrations.
2. Set `RECONNECT_SERVER_REGISTRY`, for example `legacyx-match-1=203.0.113.10:27015`, in the API `.env`.
3. Build and deploy `LegacyXReconnect.dll`.
4. Copy the plugin JSON example to a private server config, then enter the same API URL, plugin secret, server ID and address.
5. Restart API and CS2 server. Connect to server A, disconnect, connect to server B, then run `css_reconnect` to test the eligible Last Played target.

`RECONNECT_WINDOW_MINUTES` defaults to 720 minutes and accepts 5–1440. Map transitions are handled by MatchZy and generally retain the existing client connection; Reconnect does not issue match/map lifecycle commands.
