# LEGACY-X Frontend Endpoint Adapter Specification

## Scope

The uploaded `legacyxxx-frontend` source is adopted as the community-facing React application. Its existing visual design, color system, component hierarchy, routes, and interaction patterns are retained. Integration changes are limited to API service paths, response adapters, environment configuration, and loading/error/empty states.

The AdminPlus `x-api-secret` is an operator credential. It **must never be sent by browser code**. Therefore, the frontend cannot call existing `/api/*` operator routes directly; browser-safe data requires separate limited public read routes or a future authenticated consumer API.

## Current route overlap

| Frontend feature | Existing internal AdminPlus route | Browser-safe adapter required | Integration decision |
|---|---|---|---|
| Rank leaderboard | `GET /api/rank/leaderboard` | `GET /api/public/rank/leaderboard` | Expose only season, rank and public profile fields |
| Player rank | `GET /api/rank/players/:steamId` | `GET /api/public/rank/players/:steamId` | SteamID lookup, no operator data |
| XP leaderboard | `GET /api/community/experience` | `GET /api/public/community/experience` | Expose leaderboard fields only |
| Clan leaderboard | `GET /api/community/clans` | `GET /api/public/community/clans` | Expose public clan cards only |
| Community profile | `GET /api/community/players/:steamId` | `GET /api/public/community/players/:steamId` | Normalize to frontend `UserProfile` shape |
| Reconnect / Last Played | `GET /api/reconnect/players/:steamId` | Future authenticated `GET /api/v1/profile/me/reconnect` | Keep private to the signed-in player |
| Match history | `GET /api/match-core/players/:steamId/match-history` | Future authenticated `GET /api/v1/profile/me/matches` | Keep participant history private by default |
| Server operator controls | `GET/POST /api/server/*` | None | Never exposed to the community frontend |
| Match Core writes | `POST /api/plugin/match-core/events` | None | Server-to-server only |

## Endpoint adapter conventions

The frontend must use `VITE_API_URL` as a base URL and call `/api/public/*` for anonymous community data. It must not use bearer tokens for these public routes, and it must not fall back to sample data when a request fails.

The first integration release will bind only the existing truthful community data: rank, XP, clan, player community profile, and safe live match/server summaries once their public read models are available. Shop, wallet, skinchanger, tournament, feedback, and moderation workflows require additional business logic and authenticated user ownership. Their current protected visual states remain unchanged until corresponding consumer APIs exist; no fabricated financial, review, or player data will be introduced.

## Authentication boundary

The uploaded frontend expects `/api/v1/auth/steam`, token refresh, and browser-user profile endpoints. Those routes do not yet exist in the API-only AdminPlus service. Steam authentication must be added as a dedicated consumer-auth layer before protected routes can become functional. Until then, `x-api-secret`, plugin secrets, RCON configuration, and Supabase service-role credentials remain server-only.

## Environment contract

```dotenv
# Public browser base URL only. Do not place secrets in this file.
VITE_API_URL=https://api.legacy-x.example
```

The API host needs a deliberate CORS allowlist for the LEGACY-X frontend origin. Wildcard CORS is not allowed for authenticated consumer endpoints.

## Acceptance criteria

1. Existing design tokens, colors, layout, and UI behavior remain visually unchanged.
2. Public frontend requests do not contain `x-api-secret`, plugin secrets, RCON data, or Supabase credentials.
3. Existing AdminPlus operator and plugin endpoints retain their current authentication middleware.
4. Every mapped view renders an honest loading, error, and empty state rather than invented data.
5. Protected consumer routes activate only after Steam authentication and ownership checks are implemented.

## Preview observation

The imported home screen preserves its existing dark sidebar, hero media, dashboard cards, route shell, color system, and interaction hierarchy. Before `VITE_API_URL` points at a deployed API host, server and partner modules render the existing honest network-error state rather than fabricated data. This confirms the UI can remain visually unchanged while endpoints are swapped behind its existing service layer.
