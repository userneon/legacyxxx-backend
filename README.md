# LEGACY-X Backend

`legacyxxx-backend` нь **frontend-гүй**, зөвхөн API, database migration, Steam identity, CS2 plugin ingestion болон AdminPlus RCON command bridge агуулсан repository юм. UI болон static asset энэ repository-д байхгүй; API нь ирээдүйн frontend, Discord automation эсвэл internal staff tooling-д зориулсан contract л гаргана.

| Repository | Хариуцлага |
|---|---|
| `legacyxxx-backend` | API, auth, Supabase migrations, rank ingestion, AdminPlus API/RCON bridge |
| `legacyxxx-plugins` | CounterStrikeSharp source, MatchZy, AdminPlus, AFK Manager, server-only config |
| `legacyxxx-frontend` | Одоогоор intentionally empty; UI хэрэгтэй болсон үед тусдаа хөгжүүлнэ |

## Runtime layout

```text
MatchZy map_result
  → x-plugin-secret
  → AdminPlus API /api/plugin/matchzy/events
  → Supabase RPC legacy_x.ingest_rank_map_result
  → rank_player_seasons + rank_match_results + rank_leaderboard
```

AdminPlus API нь static dashboard serve хийдэггүй. Operator endpoint-ууд `x-api-secret` ашиглана; MatchZy ingestion endpoint нь тусдаа `x-plugin-secret` ашигладаг. Энэ хоёр secret заавал өөр байна.

## Local setup

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build

pnpm adminplus:install
cp adminplus/backend/.env.example adminplus/backend/.env
pnpm adminplus:check
pnpm adminplus:start
```

## Database migrations

Supabase дээр дараах migration-уудыг дарааллаар apply хийнэ:

```text
supabase/legacy_x_adminplus.sql
supabase/legacy_x_rank.sql
```

`legacy_x_rank.sql` нь `season-1` season, idempotent plugin event receipt, rank state, per-map result history, rank leaderboard view болон service-role-only RPC үүсгэнэ.

## API contracts

| Endpoint | Auth | Зориулалт |
|---|---|---|
| `GET /health` | None | API-only runtime health |
| `POST /api/plugin/matchzy/events` | `x-plugin-secret` | MatchZy remote event; зөвхөн final `map_result` rank update хийнэ |
| `GET /api/rank/leaderboard` | `x-api-secret` | Season leaderboard API |
| `GET /api/rank/players/:steamId` | `x-api-secret` | Player rank/profile API |
| `/api/players`, `/api/server`, `/api/rcon` | `x-api-secret` | AdminPlus staff/RCON actions |

Rank API болон MatchZy deployment-ийн дэлгэрэнгүйг [`docs/LEADERBOARD_RANK_INTEGRATION.md`](docs/LEADERBOARD_RANK_INTEGRATION.md), AdminPlus API-only hardening-ийг [`docs/ADMINPLUS_API_ONLY.md`](docs/ADMINPLUS_API_ONLY.md) файлаас үзнэ үү.

## Production safety

RCON port-ийг public internet-д хэзээ ч нээхгүй. `API_SECRET`, `PLUGIN_INGEST_SECRET`, Supabase service role key, Discord webhook бүгд server-only `.env`/private cfg-д байна; Git commit-д оруулахгүй. MatchZy rank private cfg-г `legacyxxx-plugins` repository доторх `.example`-оос server дээр хуулж ашиглана.
