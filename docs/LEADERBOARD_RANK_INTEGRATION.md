# LEGACY-X leaderboard & rank integration

## Purpose

Rank system нь MatchZy-ийн **final map result** event дээр суурилна. Round-by-round log нь rank өөрчилдөггүй. Иймээс duplicate round event, map rotation, retry зэрэг нь rank-г хоёр дахин нэмэхгүй.

## Data flow

```text
MatchZy
  map_result + 10 player stats + deterministic event_id
      ↓ x-plugin-secret
AdminPlus API
  validation + rate limit + plugin auth
      ↓ service role RPC
Supabase legacy_x.ingest_rank_map_result
  receipt dedupe → player season totals → per-map history → leaderboard view
```

## Rank score policy

| Component | Rating delta |
|---|---:|
| Win / loss base | `+25` / `-20` |
| K–D performance | `-12` to `+12` |
| Assists | up to `+4` |
| Headshot kills | up to `+3` |

Энэ нь эхний production baseline юм. Season эхэлсний дараа match sample бий болмогц K/D bonus, win/loss болон tier threshold-ийг server telemetry дээр үндэслэн дахин тэнцвэржүүлнэ. Initial rating `1000`; tiers нь rookie, contender, veteran, elite, legend байна.

## Migration

`supabase/legacy_x_rank.sql`-ийг `legacy_x_adminplus.sql`-ийн дараа Supabase SQL editor эсвэл migration pipeline-аар apply хийнэ. Migration нь existing `legacy_x.users` table-г ашиглан SteamID-оор player upsert хийнэ.

## MatchZy server configuration

1. `matchzy/cfg/MatchZy/legacyx-rank.private.cfg.example`-ийг CS2 server дээр `legacyx-rank.private.cfg` болгон хуулна.
2. URL-г бодит AdminPlus API HTTPS URL-р, placeholder secret-г `PLUGIN_INGEST_SECRET` утгаар солино.
3. Private cfg-г MatchZy `config.cfg`-ийн дараа execute болгоно.
4. `legacyx_rank_season` утга backend rank season slug-тэй ижил байна.

Private cfg болон secret-ийг repository-д commit хийхгүй. MatchZy бүх remote event-ийг POST хийнэ; backend зөвхөн final `map_result`-ийг боловсруулна.

## API reads

```text
GET /api/rank/leaderboard?season=season-1&limit=100
GET /api/rank/players/:steamId?season=season-1
```

Эдгээр read endpoint нь `x-api-secret` шаарддаг. Public leaderboard хэрэгтэй болсон үед тусдаа rate-limited public API/proxy нэмэх нь зөв; operator token-ийг browser-д өгч болохгүй.
