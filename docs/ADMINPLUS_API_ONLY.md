# AdminPlus API-only deployment

## Boundary

LEGACY-X AdminPlus нь dashboard/static frontend serve хийдэггүй. Энэ service нь RCON action, player/server lookup, rank read болон MatchZy plugin event ingestion хийх Express API юм. `legacyxxx-frontend` repository-д ямар ч AdminPlus source хуулахгүй.

| Secret | Header | Хэрэглэгч |
|---|---|---|
| `API_SECRET` | `x-api-secret` | Staff automation, internal tool, trusted future frontend proxy |
| `PLUGIN_INGEST_SECRET` | `x-plugin-secret` | MatchZy game server л ашиглана |

> `API_SECRET` болон `PLUGIN_INGEST_SECRET`-ийг ижил утгатай болгохгүй. Game server token тусдаа байх нь staff token алдагдсан үед plugin impersonation хийх эрсдэлийг бууруулна.

## Install

```bash
cd /srv/legacyxxx-backend
pnpm adminplus:install
cp adminplus/backend/.env.example adminplus/backend/.env
chmod 600 adminplus/backend/.env
pnpm adminplus:check
pnpm adminplus:start
```

`HOST=127.0.0.1` байлгана. Reverse proxy эсвэл VPN-ээр зөвхөн trusted staff/internal systems-д `/api/*` route-ыг гаргана. `/health` endpoint нь frontend хамааралгүй liveness check юм.

## Verification

```bash
curl http://127.0.0.1:3001/health
curl -H "x-api-secret: $API_SECRET" "http://127.0.0.1:3001/api/rank/leaderboard?season=season-1"
```

Plugin route-г curl-ээр шалгахдаа бодит match payload бүү зохиомлоор production rank-д илгээ. Энэ endpoint нь idempotent event ID болон 5v5/10 unique SteamID validation хийдэг ч зөвхөн MatchZy-ээс ирсэн final `map_result` ашиглах ёстой.
