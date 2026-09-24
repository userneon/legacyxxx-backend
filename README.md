# LEGACY-X Backend

`legacyxxx-backend` нь **frontend-гүй**, зөвхөн API, database migration, Steam identity, CS2 plugin ingestion болон AdminPlus RCON command bridge агуулсан repository юм.

| Repository | Хариуцлага |
|---|---|
| `legacyxxx-backend` | Root API (`/api/v1`), auth, Supabase migrations, ranked EXP, AdminPlus RCON bridge |
| `legacyxxx-plugins` | CounterStrikeSharp source: MatchZy + Match Core, Reconnect, Community, AdminPlus, AFK Manager, SkinBridge |
| `legacyxxx-frontend` | React website; reads only the public/user routes of the root API |

## Runtime layout

```text
CS2 server (MatchZy + LegacyX Match Core)
  → POST /api/v1/plugin/match-core/events   (plugin token, x-plugin-id: legacyx-match-core)
  → legacy_x.ingest_core_match_event          (match lifecycle, idempotent by event_id)
  → on result_final: server/legacyX/rank      (pure TypeScript EXP calculation, RANK-SYSTEM v1.0)
  → legacy_x.apply_competitive_match_exp      (one atomic, idempotent apply per match)
  → competitive_player_progression / competitive_match_exp
  → website: /api/v1/public/competitive/*
```

The plugin sends raw telemetry only; the API never trusts client-provided EXP or rank. Fun Mode never changes EXP.
See [`docs/RANK_SYSTEM.md`](docs/RANK_SYSTEM.md) and [`docs/PLUGIN_RANKED_TELEMETRY_V2.md`](docs/PLUGIN_RANKED_TELEMETRY_V2.md).

AdminPlus (`adminplus/backend`) is a separate, operator-only RCON/lookup service. It does not calculate ranks.

## Local setup

```bash
npm ci
npm run check
npm test
npm run build

npm run adminplus:install
cp adminplus/backend/.env.example adminplus/backend/.env
npm run adminplus:check
```

## Database

Schema `legacy_x` on Supabase. SQL files live in `supabase/`; the ranked system is defined by
`legacy_x_competitive_rank_exp.sql` (tables, ladder, EXP → rank lookup) and `legacy_x_rank_system_v1.sql`
(per-match history + apply function). `legacy_x_v1_cleanup.sql` removes the seasonal rank, clan, community-level
and unused match tables — run it only after the API that no longer reads them is deployed.
See [`docs/V1_CLEANUP_AUDIT.md`](docs/V1_CLEANUP_AUDIT.md).

## Main API contracts (`/api/v1`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /public/competitive/leaderboard?sort=exp\|kd\|win&q=` | Optional | Ladder; K/D and win rate need 10+ matches; includes the viewer's row |
| `GET /public/competitive/players/:userId` | None | Rank, EXP, next threshold, leaderboard position |
| `GET /public/competitive/players/:userId/matches` | Optional | Ranked history with EXP delta and breakdown |
| `GET /public/ranked-matches/:matchId` | None | One ranked match: score, rosters, EXP per player |
| `GET /competitive/me/access` | User | Pro League access (unlock 1400, kept down to 1350) |
| `GET /public/servers`, `GET /play/:mode/quick-join` | None | Live servers from reconnect heartbeats; quick join pick |
| `GET /public/killfeed?after=` | None | In-memory live kill feed (last 50, never stored) |
| `GET /tournaments`, `GET /tournaments/:id` | None | Current and past tournaments, teams, bracket |
| `POST /tournaments/:id/register`, `/check-in`, `/teams/:teamId/join`, `DELETE /tournaments/:id/registration` | User | Player-based registration |
| `POST /plugin/match-core/events` | Plugin | Match Core lifecycle; `result_final` applies EXP |
| `POST /plugin/killfeed/events` | Plugin | Kill feed entries |
| `POST /plugin/reconnect/events` | Plugin | Heartbeats (with `max_players`, `gotv_address`) and sessions |
| `GET /plugin/community/players/:steamId` | Plugin | In-game `!profile`: rank and EXP |

## Reconnect and Last Played

The Reconnect plugin records private connect/disconnect sessions and server heartbeat state. A game server is accepted only when its `server_id=host:port` mapping exactly matches `RECONNECT_SERVER_REGISTRY`. See [`docs/RECONNECT_LAST_PLAYED.md`](docs/RECONNECT_LAST_PLAYED.md).

## Production safety

RCON port-ийг public internet-д хэзээ ч нээхгүй. `API_SECRET`, `PLUGIN_INGEST_SECRET`, `MATCH_CORE_PLUGIN_SECRET`, Supabase service role key, Discord webhook бүгд server-only `.env`/private cfg-д байна; Git commit-д оруулахгүй.
