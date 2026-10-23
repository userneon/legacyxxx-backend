# LEGACY-X REST API

The REST API is mounted at `/api/v1` and uses the existing Supabase PostgreSQL `legacy_x` schema. It is server-side only: the Supabase service-role key never reaches frontend code.

## Authentication

Steam login begins at `GET /api/v1/auth/steam`; Steam redirects to `GET /api/v1/auth/steam/callback`. The callback returns an access JWT and a hashed, rotating refresh token. Send the access JWT as `Authorization: Bearer <access-token>` to authenticated user endpoints.

The API host may remain `https://api.legacyx.cc` while the Steam consent screen identifies `legacyx.cc`. Set `STEAM_OPENID_ORIGIN=https://legacyx.cc` and copy `NETLIFY_STEAM_CALLBACK_PROXY.toml` into the Netlify frontend repository. That rewrite forwards only `legacyx.cc/api/v1/auth/steam/callback` to the API callback handler, keeping the OpenID realm and return URL valid for `legacyx.cc`.

| Endpoint | Method | Access | Purpose |
|---|---:|---|---|
| `/auth/steam` | GET, POST | Public | Starts Steam OpenID login. |
| `/auth/steam/callback` | GET | Steam | Verifies claimed Steam identity and issues session tokens. |
| `/auth/steam/app` | GET | Public | The iOS app's Steam sign-in (opened in the system browser). Steam returns to `/auth/steam/app/callback`, which redirects to `legacyx://auth?code=…` (or `?error=cancelled\|failed`). |
| `/auth/app/exchange` | POST | Public | `{ code }` → `{ accessToken, refreshToken, expiresAt }`. The one-time code lives 60 seconds and works once; the app keeps the tokens in the Keychain and renews them with `POST /auth/refresh` (refresh token as Bearer). |
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
| `admin:read` | `/plugin/admin/bans` | GET | The in-game admin panel's ban list: `?steam_id=<viewer>&filter=active\|lifted\|expired\|mine&offset=`. Returns `{ stats: { active, today, permanent, mine }, items, hasMore }`, 8 per page; each item names who issued the ban, where from (`Website` or `In-game`) and, when lifted, who lifted it and when. IP bans are kept by the game servers, not here. |
| `admin:read` | `/plugin/admin/logins` | GET | The latest 10 server logins (`?server_id=&online=1&offset=`): SteamID, name, server, connected / disconnected, `online`. No IP addresses. |
| `admin:read` | `/plugin/admin/staff` | GET | Active staff with their role. |
| `bans:write` | `/plugin/penalties` | POST | In-game voice mute or chat gag (LegacyX-Admin): `{ steamId, type: "comm" \| "gag", durationMinutes (0 = permanent), reason, issuerName }` → a public penalty. `/plugin/penalties/revoke` `{ steamId, type, issuerName }` lifts them. In-game bans use `/plugin/bans` with `source: "game"` and `issuerSteamId`. |
| `bans:write` | `/plugin/admin-calls` | POST | In-game `!calladmin` / `!callmanager` / `!report` (LegacyX-Admin): `{ callerSteamId, callerName, target: "admin" \| "manager" \| "report", serverId, serverName?, map?, players?, onlineStaff? }`; a `report` also needs `reportedSteamId`, `reportedName`, `reason` (max 300). One row per request; the same caller (and, for a report, the same reported player) within 60 s is ignored (`{ recorded: false, reason: "cooldown" }`). Needs `supabase/legacy_x_admin_calls.sql`. |
| `discord:link` | `/plugin/admin-calls?after=<id>` | GET | The Discord bot's feed: `{ calls: [...], latestId }`, oldest first, at most 50, nothing older than 24 h. Without `after` it returns no calls, only `latestId`, so a new channel starts from now. |
| `bans:read` | `/plugin/bans/check` | POST | `{ steamIds: [...], ips: [...] }` (up to 128 each) → `{ bans: [{ steamId, reason, isPermanent, expiresAt }], ipBans: [{ ip, reason, isPermanent, expiresAt }] }` for bans still in force. LegacyX-Admin calls it on connect and every 30 s to kick banned players. |
| `bans:read` | `/plugin/players/access` | POST | `{ steamIds: [...] }` (1–32) → `{ players: [{ steamId, loggedIn, cooldown: { until, minutes } \| null }] }`. `loggedIn` = the player holds a live (not revoked, not expired) website session; a Steam ID with no account is not logged in. `cooldown` = blocked from playing for leaving ranked matches: within 24 hours the 1st and 2nd leave only cost EXP, the 3rd blocks 30 minutes and each later leave 30 more (4th 60, 5th 90 …), counted from the latest leave (the `leaver` rows of `competitive_match_exp`). LegacyX-Admin asks on connect and kicks with the reason. |
| user | `/play/status` | GET | `{ leavesToday, cooldown: { until, minutes } \| null, next: { cooldownMinutes } }` for the signed-in player: the website's Connect button is inactive while `cooldown` is set. |
| `bans:read` | `/plugin/bans/active` | GET | `{ bans: [{ steamId \| null, ip \| null, name, reason, isPermanent, expiresAt }] }`: every active ban, SteamID and IP, newest first (up to 500). LegacyX-Admin keeps no ban files; this is its copy for the ban menus. |
| `bans:write` | `/plugin/bans/ip` | POST | `{ ip, durationMinutes (0 = permanent), reason, issuerName, issuerSteamId? }` → an IP ban (no penalty record). `/plugin/bans/ip/revoke` `{ ip, issuerName }` lifts it. Needs `supabase/legacy_x_ip_bans.sql`. |
| `bans:read` | `/plugin/penalties/active` | GET | `{ penalties: [{ steamId, name, type: "comm" \| "gag", reason, isPermanent, expiresAt, createdAt, issuer }] }`: every mute and gag still in force (up to 1000), so the game server needs no file of its own. |
| `discord:link` | `/plugin/discord/link-requests` | POST | `{ discordId, discordName }` → `{ url, expiresAt }`: a one-time, 10-minute link. The player opens `url` (`GET /auth/steam/discord/:token`), signs in with Steam, and `/auth/steam/discord/:token/callback` (under `/auth/steam`, so the legacyx.cc proxy for the Steam callback already covers it) links that Discord ID to their user (`complete_discord_link`, one Discord account per user). Used by the Discord bot's `/link`. |
| `discord:link` | `/plugin/discord/links` | GET | `{ links: [{ discordId, discordName, linkedAt, steamId, username, rankId, rankName, currentExp, matchesCompleted, clanRole, staffRole, creatorTier, boosterPlace }] }` for role sync (`staffRole`: owner/manager/admin/developer/designer; `creatorTier`: main/creator; `boosterPlace`: 1-3 for the top boosters still boosting). `/plugin/discord/links/:discordId` returns one (`404` when unlinked). |
| `discord:link` | `/plugin/discord/checks` | POST | `{ discordId, steamId }`: the Discord bot's "New check" button. The member is whoever linked that Discord account and must be an active Admin, Manager or Owner (`403` otherwise); `409` when the player already has an open check. Returns what `POST /checks` returns: `{ id, code, expiresAt, steamId, downloadAvailable, downloadKind, downloadPath, downloadUrl, checkerSha256 }`. |
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

## Shop goods (real items: NFC charms, stickers)

Run `supabase/legacy_x_shop_goods.sql` once. Nothing is paid through the API: a player asks, an Owner or Manager contacts them and takes the payment (bank transfer or QPay), then moves the order along.

| Path | Method | Auth | Notes |
| --- | --- | --- | --- |
| `/shop/products` | GET | Public | Enabled products `{ id, slug, name, description, kind, priceMnt, imageUrl, stock, grantsLx }`, cached 30 s. The Genesis pack (`kind: "founder"`, named Founder before 2026-10-23) also carries `founder: { limit, taken, remaining, endsAt, open }`. |
| `/shop/orders` | POST | User | `{ productId, quantity 1-10, phone, note? }` → the order (status `new`). 409 `shop_out_of_stock`; 429 `shop_too_many_orders` at 5 open orders. Genesis pack: quantity 1, 409 `founder_closed` / `founder_owned` / `founder_ordered`. Marking a Genesis order `paid` (PUT `/staff/shop/orders/:id`) gives the next number (409 `founder_sold_out` past the limit) and the Genesis frame, Gold Foil banner and Genesis title; the profile overview then carries `founder` (number), `banner` and `title`. |
| `/shop/orders/me` | GET | User | The player's own orders. |
| `/staff/shop/orders` | GET | Owner or Manager | Orders still open (or `?status=`), with the player's phone and note. |
| `/staff/shop/orders/:orderId` | PUT | Owner or Manager | `{ status }`: `new`, `contacted`, `paid`, `shipped`, `done`, `cancelled`. |
| `/staff/shop/products` | GET | Owner or Manager | Every product, including disabled ones, with `enabled` and `sort`. |
| `/staff/shop/products/:slug` | PUT | Owner or Manager | Create or change a product `{ name, description, kind, priceMnt, imageUrl (https), stock, enabled, sort }`. |

### LX top-up packages

Run `supabase/legacy_x_lx_topups.sql` after the goods SQL. A product of kind `lx` is a package: `grantsLx` LX are credited to the buyer's wallet (reason "LX top-up: <name>", ref `topup:<order id>`, so once per order) when an Owner or Manager sets its order to `paid`, and the player gets a "LX added" notification. Setting `paid` again changes nothing; cancelling a paid order after the fact does not take the LX back. The rate is 3,000 LX = 20,000 MNT. Playing earns no LX unless `LX_PLAY_EARNING=on`.

SQL added on 2026-10-22 and 2026-10-23, to run in this order after the two above (each is safe to run again):
1. `legacy_x_cosmetics_emotes.sql`: the `emote` cosmetic kind, 8 chat emotes and the `game_key` column (the name an animated emote has in FortniteEmotesNDances). The `/cosmetics` answer gains `emotes`, `equippedEmote`, and `/plugin/community/players/:steamId` gains `emotes: { equipped, owned }`.
2. `legacy_x_founder.sql` (then `legacy_x_genesis_rename.sql` if the first ran before the rename: Founder became Genesis because Founder is a staff role): the `banner` and `title` kinds, the Genesis frame/banner/title, the Genesis product (30,000 MNT, 500 packs, ends 30 Nov 2026 Ulaanbaatar time), `legacy_x.founders` and `founder_claim()`. Staff change the pack count with the product's stock; `ends_at` is changed in SQL only.
3. `legacy_x_booster_podium.sql`: the Booster Gold, Silver and Bronze frames. The API gives them to the top three boosters on Leaders → Boosters and takes them from whoever loses the place (when the Discord bot reports and when a member links Discord).
4. `legacy_x_cosmetics_retire_duplicates.sql`: switches off four name colours that look like another one and refunds their buyers once, at the current price.
5. Optional: the file `lx_emotes_sql` writes (in the game server's plugin folder) adds a Shop row for every animated emote the server has.
6. `legacy_x_creator_applications.sql`: the `creator_applications` table. A signed-in player sends `POST /creators/applications` {bio, links} (one open application per player; 7 days to ask again after a decline; `GET /creators/applications/me` tells the page where it stands). Owners and Managers list `GET /staff/creators/applications` and answer with `PUT /staff/creators/applications/:id` {decision: approve|decline, tier, note}; approving creates the `content_creators` row and both outcomes notify the player.


Staff player picker (owner request 2026-10-23): `GET /moderation/roster?query=` (any staff who can ban) returns up to 40 players, the most recently active first or those whose name matches, as `{steamId, name, avatar, level}`; the staff site uses it so nobody types a SteamID.
The Server Booster frame lasts only while the member boosts (owner decision 2026-10-23): the API takes it back when a Discord report that lists every booster (`boostersComplete`) no longer has them.
