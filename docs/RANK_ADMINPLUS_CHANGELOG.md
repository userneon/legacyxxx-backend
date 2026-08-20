# LEGACY-X AdminPlus API-only & Rank Integration Changelog

## Scope

This change converts AdminPlus from an upstream dashboard-oriented module into a **frontendless API/RCON bridge** and adds the first LEGACY-X competitive rank pipeline. The runtime source of truth is deliberately split across `legacyxxx-backend` and `legacyxxx-plugins`; no frontend bundle is built, hosted, or required.

## Architecture

```text
CS2 MatchZy final map_result
  → server-only x-plugin-secret
  → AdminPlus API validation/rate-limit
  → Supabase RPC ingest_rank_map_result
  → rank player season + history + leaderboard
```

| Layer | Change |
|---|---|
| Backend package | React, Vite, Tailwind, Radix, Wouter and other browser-only dependencies removed; package graph is backend-only. |
| AdminPlus API | CORS/frontend-origin contract removed; API exposes health, staff rank reads and plugin event ingestion. |
| Plugin authentication | `x-plugin-secret` is independent from staff `x-api-secret`, timing-safe compared and rate-limited. |
| Rank ingestion | Only final MatchZy `map_result` is eligible; the service validates an exact 5v5 roster and 10 unique SteamID64 values. |
| Idempotency | MatchZy emits deterministic `event_id`; Supabase receipt storage ignores retried/duplicate map results. |
| Rank model | Initial rating is 1000. Wins/losses, bounded K/D performance, assists and headshot kills contribute to season rating. |
| Public exposure | Rank read endpoints are staff-token protected by default. A public leaderboard, if needed later, must use a separate rate-limited proxy rather than expose operator secrets in a browser. |

## New backend assets

| Asset | Purpose |
|---|---|
| `supabase/legacy_x_rank.sql` | Rank season/state/result/receipt tables, leaderboard view and service-role RPC. |
| `adminplus/backend/src/routes/plugin-events.js` | MatchZy remote event ingress. |
| `adminplus/backend/src/routes/rank.js` | Staff leaderboard and player rank API. |
| `adminplus/backend/src/rank.js` | Exact 5v5 payload normalization and validation. |
| `adminplus/backend/src/middleware/plugin-auth.js` | Plugin-specific authentication and rate limit. |
| `docs/LEADERBOARD_RANK_INTEGRATION.md` | Migration and server configuration runbook. |

## New MatchZy assets

| Asset | Purpose |
|---|---|
| `MatchZy/Events.cs` | Adds deterministic rank `event_id`, map name and season to final map results. |
| `MatchZy/Utility.cs` | Emits final team rosters and player stats with the map result. |
| `cfg/MatchZy/legacyx-rank.private.cfg.example` | Server-only endpoint/secret configuration template. |
| `RANK_BRIDGE.md` | Plugin integration ownership and deployment instructions. |

## Verification completed

| Check | Result |
|---|---|
| Root TypeScript check | Passed |
| Root backend production build | Passed |
| AdminPlus JavaScript syntax | Passed |
| Rank payload contract test | Passed: exact 5v5 accepted; duplicate SteamID and incomplete team rejected |
| API runtime smoke test | Health returned API-only mode; operator and plugin endpoints rejected missing credentials with HTTP 401 |
| MatchZy Release build | Passed |
| AdminPlus CounterStrikeSharp Release build | Passed |
| AFK Manager Release build | Passed with eight existing upstream nullable warnings and no errors |
| AdminPlus production dependency audit | No known vulnerabilities |
| Root production dependency audit | No known vulnerabilities after server dependency updates |
| Secret scan / whitespace check | Passed; no actual token committed |

## Production actions still required

1. Apply `legacy_x_adminplus.sql` and then `legacy_x_rank.sql` to the intended Supabase project.
2. Create a unique 32+ character `PLUGIN_INGEST_SECRET`; do not reuse `API_SECRET`.
3. Copy MatchZy's private rank cfg example to the CS2 server, set the real HTTPS API URL/secret, and execute it after `config.cfg`.
4. Run one real exact-5v5 map end-to-end and confirm a single `rank_match_results` row plus ten `rank_player_seasons` updates appear.
5. Inspect demo/result persistence before enabling rank changes for every competitive server.
