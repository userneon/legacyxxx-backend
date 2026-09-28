# LEGACY-X REST API

The REST API is mounted at `/api/v1` and uses the existing Supabase PostgreSQL `legacy_x` schema. It is server-side only: the Supabase service-role key never reaches frontend code.

## Authentication

Steam login begins at `GET /api/v1/auth/steam`; Steam redirects to `GET /api/v1/auth/steam/callback`. The callback returns an access JWT and a hashed, rotating refresh token. Send the access JWT as `Authorization: Bearer <access-token>` to authenticated user endpoints.

The API host may remain `https://api.legacyx.cc` while the Steam consent screen identifies `legacyx.cc`. Set `STEAM_OPENID_ORIGIN=https://legacyx.cc` and copy `NETLIFY_STEAM_CALLBACK_PROXY.toml` into the Netlify frontend repository. That rewrite forwards only `legacyx.cc/api/v1/auth/steam/callback` to the API callback handler, keeping the OpenID realm and return URL valid for `legacyx.cc`.

| Endpoint | Method | Access | Purpose |
|---|---:|---|---|
| `/auth/steam` | GET, POST | Public | Starts Steam OpenID login. |
| `/auth/steam/callback` | GET | Steam | Verifies claimed Steam identity and issues session tokens. |
| `/auth/logout` | POST | User JWT | Revokes the caller's refresh session(s) and clears cookies. |
| `/auth/refresh` | POST | Public with refresh token | Revokes and rotates a refresh token. |
| `/auth/me` | GET | User JWT | Returns the current LEGACY-X user and stats. |

## Public and user endpoints

| Area | Endpoints |
|---|---|
| Rank and players | `GET /leaderboard?sort=rating|kd_ratio|experience&limit=&offset=`, `GET /players/leaderboard`, `GET /players/:playerId` |
| Profiles | `GET /profile/:userId`, `/stats`, `/matches`, `/penalties`; `PUT /profile/me`; `PUT /profile/me/links` |
| Servers and matches | `GET /servers`, `/servers/stats`, `/servers/:serverId`; `POST /servers/:serverId/join`; `GET /matches`, `/matches/:matchId`; `POST /matches/:matchId/join`, `/favorite` |
| Clans | `GET /clans`, `/clans/me`, `/clans/:clanId`, `/clans/:clanId/members`; `POST /clans`, `/clans/:clanId/join`, `/leave`; `DELETE /clans/:clanId` |
| Tournaments | `GET /tournaments/info`, `/matches`, `/matches/:matchId`, `/bracket`; `POST /tournaments/register` |
| Store and wallet | `GET /store/items`, `/store/items/:itemId`, `POST /store/items/:itemId/purchase`; `GET /wallet`, `/wallet/transactions`; `POST /wallet/charge` (staff only) |
| Moderation and feedback | `GET /penalties`, `/penalties/stats`, `/penalties/:penaltyId`, `GET /feedback`, `POST /feedback` |
| Search and community | `GET /search/players?q=`, `/search/clans?q=`, `GET /community/content` |

## Plugin ingestion API

Plugin routes require `Authorization: Bearer <raw-plugin-token>`. The server SHA-256 hashes the supplied token and looks it up in `legacy_x.api_tokens`; the raw token is never stored. Every permitted server, match, map, and history write records an audit entry.

| Scope | Endpoint | Method | Purpose |
|---|---|---:|---|
| `maps:write` | `/plugin/maps` | POST | Creates or updates a canonical CS2 map. |
| `servers:write` | `/plugin/servers` | POST | Creates a game-server record. |
| `servers:write` | `/plugin/servers/:serverId/status` | PUT | Updates live server state. |
| `matches:write` | `/plugin/matches` | POST | Creates a match. |
| `matches:write` | `/plugin/matches/:matchId` | PATCH | Updates match score, state, and player counts. |
| `stats:write` | `/plugin/player-match-history` | POST | Writes history, aggregate stats, and audit data atomically. |
| `community:write` | `/community/content` | POST | Upserts a creator or partner and records an audit entry. |
| `bans:write` | `/plugin/bans` | POST | Central SteamID ban (`{ steamId, durationMinutes (0 = permanent), reason, issuerName }`): writes the public `penalties` row and the linked `bans` row, creating the player's user row if needed. Returns `{ ban, player: { steamId, username, avatar } }`. Used by the Discord bot's `/ban`. |
| `bans:write` | `/plugin/bans/revoke` | POST | Lifts every active ban of a SteamID (`{ steamId, issuerName, reason? }`) and marks its ban penalties unbanned. Returns `{ bansLifted, penaltiesLifted, player }`. Used by `/unban`. |
| `servers:write` | `/plugin/servers/heartbeat` | POST | Every CS2 server (LegacyX-Status) every 30 s: `{ serverId, name, address, gotvAddress?, map, mode, maxPlayers, players: [{ steamId, name }] }`. `ingest_server_heartbeat` updates `reconnect_servers` (Play pages, home tiles, Discord boards) and `reconnect_sessions` (who is playing where) in one transaction. |
| `bans:write` | `/plugin/bans/revoke-all` | POST | `!cleanbans` on a CS2 server: `{ issuerSteamId, issuerName }` lifts every ban and ban penalty, only if `issuerSteamId` belongs to an active website OWNER (checked by the API, `403` otherwise). |
| `bans:write` | `/plugin/penalties` | POST | In-game voice mute or chat gag (LegacyX-Admin): `{ steamId, type: "comm" \| "gag", durationMinutes (0 = permanent), reason, issuerName }` → a public penalty. `/plugin/penalties/revoke` `{ steamId, type, issuerName }` lifts them. In-game bans use `/plugin/bans` with `source: "game"` and `issuerSteamId`. |
| `bans:read` | `/plugin/bans/check` | POST | `{ steamIds: [...] }` (up to 128) → `{ bans: [{ steamId, reason, isPermanent, expiresAt }] }` for bans still in force. LegacyX-Admin calls it on connect and every 30 s to kick banned players. |
| `discord:link` | `/plugin/discord/link-requests` | POST | `{ discordId, discordName }` → `{ url, expiresAt }`: a one-time, 10-minute link. The player opens `url` (`GET /auth/steam/discord/:token`), signs in with Steam, and `/auth/steam/discord/:token/callback` (under `/auth/steam`, so the legacyx.cc proxy for the Steam callback already covers it) links that Discord ID to their user (`complete_discord_link`, one Discord account per user). Used by the Discord bot's `/link`. |
| `discord:link` | `/plugin/discord/links` | GET | `{ links: [{ discordId, discordName, linkedAt, steamId, username, rankId, rankName, currentExp, matchesCompleted }] }` for rank-role sync. `/plugin/discord/links/:discordId` returns one (`404` when unlinked). |
| `discord:link` | `/plugin/discord/links/:discordId` | DELETE | Removes the link → `{ unlinked }`. Used by `/unlink`. |

Create a token on the VPS with `node --env-file=.env scripts/create-api-token.mjs <name> <scope...>`; it prints the raw token once and stores only the hash.

For CS2 servers use `node --env-file=.env scripts/create-game-server.mjs <host> <port>[:mode[:name]] [...]` instead: it creates one token (every scope the plugins use) for the machine and writes the one `CounterStrikeSharp/.env` all its servers share (`./legacyx-srv-<host>.env`). Each server tells itself apart by its `-port`: id `srv-<port>`, address `<host>:<port>`, plus the mode and name given for that port. Running it again replaces the machine's token.

The API database functions live in `supabase/legacy_x_api_functions.sql` and `supabase/legacy_x_api_transactions.sql`. They make clan creation, purchases, wallet credits, link replacement, community writes, and player-result ingestion transactional.

## Required configuration

| Variable | Where used | Notes |
|---|---|---|
| `SUPABASE_URL` | Server | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Service-role secret; do not expose it to browser code. |
| `JWT_SECRET` | Server | Signs API access tokens. |
| `STEAM_OPENID_ORIGIN` | Server | `https://legacyx.cc`; controls Steam realm and callback host. |
| `STEAM_WEB_API_KEY` | Server | Steam Web API key used only to retrieve persona names and avatar URLs after OpenID verification. |

Steam OpenID does not require a password system. Before production, ensure the configured `https://legacyx.cc/api/v1/auth/steam/callback` address is reachable over HTTPS through the included frontend rewrite; the API generates `openid.return_to` and `openid.realm` from `STEAM_OPENID_ORIGIN`.

After OpenID verifies the Steam ID, the server calls Steam Web API `GetPlayerSummaries` with the server-only `STEAM_WEB_API_KEY`. It stores `personaname` in `legacy_x.users.username` and the best available avatar URL in `legacy_x.users.avatar`, matching by `steam_id`. Repeated logins update that same user row; this flow does not alter `level` or `rank`.

## Supabase requirements and security

The `legacy_x` schema must remain listed in Supabase **API Exposed schemas**. The migration `legacy_x_service_role_grants.sql` grants the API's `service_role` access to that schema without granting `anon` or `authenticated` access.

> **RLS is not enabled on the original `legacy_x` tables.** The server client can operate while RLS is disabled, but direct browser use of the Supabase project must remain prohibited. Before using any browser Supabase client, enable RLS and add policies designed around Steam JWTs or a separate identity bridge. Enabling RLS without policies blocks access.

The REST router applies a 120-request-per-minute IP limit in production and denies browser CORS by default. Configure a narrow allowlist in code before allowing any separate frontend origin.
