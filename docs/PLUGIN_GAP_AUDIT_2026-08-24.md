# LEGACY-X Plugin ба Live Server Integration Gap Audit

**Огноо:** 2026-08-24  
**Хамрах хүрээ:** `reconnect`, `matchzy`, `legacyx-skinbridge`, Server Info live-match modal, Home temporary reconnect card.  
**Архитектурын зааг:** Browser → Root API → Supabase, Plugin → Root API → Supabase. Production-д mock roster, score, EXP, ADR, ping эсвэл spectator оруулахгүй.

## Товч дүгнэлт

Server Info болон Home Reconnect-ийн **frontend/backend суурь одоо бодит Root API өгөгдөлтэй** болсон. Тухайлбал `GET /api/v1/reconnect/me` нь SteamID-г browser-оос авч болохгүй, зөвхөн баталгаажсан JWT-ээс авч, тасарсан, сервер нь online, deadline нь хүчинтэй тоглогчид л нэг түр reconnect card буцаадаг. Гэхдээ CS2 plugin-оос live team snapshot болон Match Core-ийн дууссан match state ирэхгүй байгаа тул frontend эдгээрийг зохиомлоор харуулахгүй.

| Хэсэг | Одоо production-д бэлэн бодит capability | Үлдсэн plugin/integration gap | Эрсдэл |
|---|---|---|---|
| Server Info | Root API, map-aware modal, refresh, roster-only fallback, stale snapshot хамгаалалт | T/CT roster, round, score, rank, ADR, ping, spectator snapshot emitter | Өндөр |
| Home Reconnect | JWT-д суурилсан `GET /reconnect/me`, deadline/server-online/rejoin шүүлт, Steam connect pending UI | Match finished state болон durable plugin delivery | Өндөр |
| Reconnect plugin | connect/disconnect/heartbeat, `css_reconnect` command | durable queue, retry/backoff, restart safety, strict address allowlist | Өндөр |
| MatchZy Match Core | бодит roster/lifecycle/final result payload үүсгэх суурь | idempotency, durable outbox, restart-safe state, contract test | Өндөр |
| SkinBridge | session → claim job → acknowledge API client | real server runtime apply, retry/lease hardening, in-game proof | Өндөр |

## 1. Server Info Live Match

**Шалгасан source:**

- `legacyxxx-frontend/src/components/server-live-match-dialog.tsx`
- `legacyxxx-frontend/src/pages/play.tsx`
- `legacyxxx-backend/server/legacyX/routes.ts`
- `legacyxxx-backend/supabase/legacy_x_server_live_match.sql`

Production modal нь сонгосон server ID-аар Root API-г дууддаг. Snapshot байхгүй эсвэл хуучирсан үед **connected player-only** fallback-ийг харуулна; T/CT тал, score, round, player metric-ийг зохиомлоор гаргахгүй. `routes.ts` нь `reported_at` 90 секундээс хуучирсан snapshot-г live гэж харуулахаа больсон тул хуучин score/roster харагдахгүй.

> Одоогийн snapshot schema нь `state`, `map_name`, `round_number`, `score_t`, `score_ct`, T/CT JSON roster болон `reported_at`-тай. Rank, ADR, ping, spectator талбар байхгүй.

### Шаардлагатай plugin capability

Server-side emitter нь bounded interval болон match state өөрчлөгдөх бүрд дараах бодит payload-г Root API руу илгээх шаардлагатай.

1. `server_id`, map, `captured_at`, round, T score, CT score;
2. Connected тоглогч бүрийн SteamID, display name, side (`t`, `ct`, `spectator`), боломжтой бол ping болон ADR;
3. Unique event ID эсвэл monotonic revision;
4. Signed plugin request, retry/backoff, duplicate-safe ingest, stale expiry semantics.

Root API нь payload validation, authorization, freshness-г шалгаж `live_snapshot`, `roster_only`, `stale`, `unavailable` зэрэг тодорхой availability төлөв буцаах ёстой.

## 2. Home Temporary Reconnect

**Шалгасан source:**

- `legacyxxx-frontend/src/pages/home.tsx`
- `legacyxxx-frontend/src/api/servers.ts`
- `legacyxxx-backend/server/legacyX/routes.ts`
- `legacyxxx-backend/supabase/legacy_x_reconnect.sql`
- `legacyxxx-plugins/reconnect/LegacyXReconnect.cs`

Production `GET /api/v1/reconnect/me` contract нь `reconnect_last_played` view-ээс зөвхөн тухайн JWT SteamID-ийн сүүлийн eligible session-ийг авна. Эдгээр нөхцөл зэрэг биелэхгүй бол `{ reconnect: null }` буцаана:

| Шалгуур | Зорилго |
|---|---|
| `disconnected_at` байна | Холбогдсон тоглогчид card гаргахгүй. |
| `server_online = true` | Offline server рүү Steam URI өгөхгүй. |
| `reconnectable_until > now()` | Хугацаа дууссан card гаргахгүй. |
| Шинэ active session байхгүй | Тухайн тоглогч сервертээ эсвэл өөр серверт дахин орсон бол card-г арилгана. |
| `host:port` strict validation | Malformed connect address-ийг Steam URI руу дамжуулахгүй. |

Frontend нь card-ийг зөвхөн бодит response ирэхэд render хийнэ. **Reconnect** дарснаар `steam://connect/<address>` нээгдэж, card зөвхөн pending болно; дараагийн API read нь `null` болоход л бүхэлдээ алга болно. Focus болон pending үеийн хяналттай refetch ашиглана; тогтмол өндөр давтамжийн polling хийхгүй.

### Одоогийн зайлшгүй хязгаар

`reconnect_servers`/`reconnect_sessions` schema нь **match дууссан** гэдгийг баталгаатай мэдэх state агуулаагүй. Тиймээс одоогийн production card нь disconnect, server online, deadline, confirmed rejoin/other active session гэсэн бодит дохиогоор л алга болно. Match дуустал гарч байгаад match дуусмагц алга болгох бол Match Core-оос signed `match_finished` эсвэл active-assignment state Root API-д хэрэгтэй.

## 3. Reconnect Plugin Hardening

**Шалгасан source:** `legacyxxx-plugins/reconnect/LegacyXReconnect.cs`

`LegacyXReconnect.cs` нь бодит connect/disconnect event болон heartbeat илгээж, `css_reconnect` command ашигладаг. Production reliability-д дараах ажлууд үлдсэн.

1. Memory-only дамжуулалтаас үл хамаарах durable queue/outbox;
2. Bounded retry/backoff, jitter, shutdown cancellation;
3. Event ID-гаар idempotency болон duplicate/late delivery test;
4. Restart үед current session, heartbeat, retry state-ийг сэргээх;
5. Connection address-ийн strict allowlist (өөрийн server CIDR/domain/port); 
6. API outage, duplicate event, late disconnect, plugin restart гэсэн integration test.

## 4. MatchZy / Match Core

**Шалгасан source:** `legacyxxx-plugins/matchzy/LegacyXMatchCore.cs`

MatchZy нь бодит roster, lifecycle event, local reconnect snapshot, fill assignment, final-result eligibility гаргах суурьтай. 5v5 match lifecycle, Server Info snapshot, reconnect match-finished removal, competitive rank/EXP бүгд үүнээс найдвартай state авах нь зохистой.

| Шаардлагатай ажил | Яагаад хэрэгтэй вэ |
|---|---|
| Schema-versioned payload + correlation/idempotency key | Duplicate event ба API retry үед state давхардахгүй. |
| Durable outbox + bounded retry/backoff | API outage үед lifecycle/result алдахгүй. |
| Restart-safe match ID, revision, slots, snapshots | Server/plugin restart дараа match state тасрахгүй. |
| Root API response validation (`revision`, `slots_ready`) | Plugin ба backend contract зөрөхөөс сэргийлнэ. |
| Disconnect/reconnect/fill/outage/restart/final-result E2E test | Rank/EXP болон reconnect зөв ажиллаж байгааг нотлоно. |

## 5. SkinBridge / Skinchanger Plugin

**Шалгасан source:**

- `legacyxxx-plugins/weaponpaints-legacyx/LegacyXSkinApiClient.cs`
- `legacyxxx-backend/server/legacyX/routes.ts`

`LegacyXSkinApiClient` нь session → claim jobs → acknowledge урсгалыг API-only байдлаар дагадаг. Web/database талын Skinchanger persistence бэлэн боловч game server runtime байхгүй учраас in-game apply-г production гэж зарлах боломжгүй.

| Үлдсэн ажил | Яагаад хэрэгтэй вэ |
|---|---|
| Bounded retry/backoff, cancellation | Түр API downtime-д job/event алдахгүй. |
| Lease expiry ба duplicate acknowledge policy | Crash/retry үед нэг job-г давхар apply хийхгүй. |
| Production secret rotation/config injection | Plugin credential repo/config-д үлдэхгүй. |
| Real in-game apply/failure acknowledgement test | UI нь apply болсон мэт буруу харагдуулахгүй. |
| Жинхэнэ CS2 server integration test | Live claim/apply урсгалыг нотлоно. |

## 6. Шийдвэр гаргах дараалал

1. **Live match snapshot emitter**-ийг approve/defer хийх. Энэ байхгүй үед Server Info зөвхөн roster-only fallback-тай байна.
2. **Reconnect durable delivery**-г approve/defer хийх. Одоогийн Home card нь API-д ирсэн event-ийн үнэн зөвөөс шууд хамаарна.
3. **MatchZy reliability hardening**-ийг approve хийх эсэх. Match finished removal, 5v5 result, rank/EXP, fill/reconnect restart-safe болох үндэс болно.
4. Жинхэнэ game server бэлэн болсон дараа л **SkinBridge runtime integration test**-ийг approve хийх. Энэ audit нь game server суулгах/configure хийх ажил хийгээгүй.

## 7. Non-Destructive Status

Энэ audit болон production integration нь existing user, review, skinchanger, match, server record устгаагүй. Шинэ Home reconnect endpoint нь existing `legacy_x.reconnect_last_played` view болон session table-ийг service-role Root API дотроос read-only ашиглаж байна. Browser Supabase эсвэл plugin credential рүү шууд хандахгүй.
