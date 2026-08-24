# LEGACY-X Plugin-Ready Contract v1

**Огноо:** 2026-08-24  
**Зорилго:** Reconnect, Match Core/MatchZy, live snapshot, SkinBridge нь browser эсвэл Supabase руу шууд орохгүйгээр зөвхөн Root API-аар холбогдох production contract.

> Canonical урсгал: **Plugin → `https://api.legacyx.cc/api/v1` → Supabase**. Plugin config болон browser bundle-д database URL, anon key, service-role key байх ёсгүй.

## 1. Shared Plugin Request Rules

| Талбар | Дүрэм |
|---|---|
| Authentication | `x-plugin-secret` эсвэл `Authorization: Bearer <plugin-secret>`; мөн `x-plugin-id` заавал илгээнэ. |
| Event ID | Retry бүрт **нэг event ID-г дахин ашиглана**. Шинэ retry бүрт GUID солихыг хориглоно. |
| Retry | `408`, `429`, `5xx`, timeout үед exponential backoff + jitter ашиглана. `400`/`403` дээр retry хийхгүй, operator log гаргана. |
| Payload | Versioned payload-д unknown field оруулахгүй. API validation алдаа гарвал payload-оо засах хүртэл retry хийхгүй. |
| Secrets | Secret нь private server config/environment-д л байна. Git, client, browser log, screenshot-д оруулахгүй. |

| Plugin identity | Required scope | Canonical API endpoint |
|---|---|---|
| `legacyx-reconnect` | `servers:write` | `POST /plugin/reconnect/events` |
| `legacyx-live-snapshot` | `servers:write` | `POST /plugin/live-match/snapshots` |
| `legacyx-match-core` | `matches:write` | `POST /plugin/match-core/events` |
| `legacyx-skinbridge` | `skinchanger:read`, `skinchanger:write` | session, job claim, job ack endpoints |

## 2. Live Match Snapshot v1

`POST /api/v1/plugin/live-match/snapshots` нь тусдаа snapshot emitter-д зориулагдсан. Reconnect plugin нь heartbeat payload доторх `live_match`-аар ижил v1 body-г илгээж болно.

```json
{
  "event_id": "live-snapshot-server-1-42",
  "server_id": "legacyx-match-1",
  "live_match": {
    "schema_version": 1,
    "snapshot_revision": 42,
    "captured_at": "2026-08-24T15:00:00.000Z",
    "state": "live",
    "map_name": "de_nuke",
    "round_number": 14,
    "score_t": 7,
    "score_ct": 6,
    "terrorist_players": [],
    "counter_terrorist_players": [],
    "spectator_players": []
  }
}
```

Тоглогчийн optional бодит field нь `rank_id` (1–18), `rank_name`, `rank_image_key` (`rank-01`…`rank-18`), `adr`, `ping` юм. Plugin энэ metric-ийг үнэн зөв гаргаж чадахгүй бол **field-ийг огт илгээхгүй**. UI нь хоосон утга зохиохгүй.

Snapshot-ийн `captured_at` нь серверийн одоогийн цагаас 5 минутын дотор, ирээдүй рүү 60 секундээс бага зөрүүтэй байх ёстой. `snapshot_revision` нь server бүрт өсөх ёстой. Хуучин revision `stale`, давхар event ID `duplicate` хариу авна; эдгээр нь retry хийх алдаа биш.

## 3. Reconnect ба Match Core

Reconnect plugin нь `POST /api/v1/plugin/reconnect/events` рүү `player_connected`, `player_disconnected`, `server_heartbeat` event-ээ илгээнэ. Heartbeat нь эхлээд `reconnect_servers`-ийг сэргээдэг тул live snapshot илгээхээс өмнө server heartbeat амжилттай байх ёстой.

Home-ийн `GET /api/v1/reconnect/me` нь зөвхөн signed user session-аас SteamID авна. Card нь тасарсан session, online server, хүчинтэй deadline, дахин орсон session байхгүй үед л харагдана. Мөн Match Core-ийн `FINISHED`/`CANCELLED` state нь disconnect-оос хойш үүссэн бол card-г буцаахгүй.

Match Core нь `POST /api/v1/plugin/match-core/events` рүү өөрийн `event_id`, `match_id`, `expected_revision`-тай payload илгээнэ. API response дахь `result.revision` болон `result.slots_ready`-г дараагийн event-ээ үүсгэхээс өмнө хадгална. `stale` response нь remote revision-ээ дахин уншаад state reconciliation хийх дохио; local memory state-г шууд хүчээр overwrite хийх дохио биш.

`POST /api/v1/plugin/matchzy/events` нь backward-compatible telemetry endpoint хэвээр боловч competitive EXP эсвэл authoritative match state үүсгэхгүй. Production MatchZy integration нь заавал `legacyx-match-core` contract-оор дамжина.

## 4. SkinBridge

SkinBridge-ийн дараалал: session (`/plugin/skinchanger/sessions`) → job claim (`/plugin/skinchanger/jobs`) → lease-token-той ack (`/plugin/skinchanger/jobs/:jobId/ack`). Lease хугацаа дууссан эсвэл invalid token-той ack-г дахин apply гэж тооцож болохгүй. Plugin нь claim response-д байгаа `lease_expires_at`-аас өмнө нэг л удаа apply/ack хийх бөгөөд timeout бол дахин claim хийх ёстой.

`failed` ack нь `failureCode`, богино `failureDetail` илгээнэ. UI нь зөвхөн `applied` acknowledgement ирсний дараа game runtime apply-г амжилттай гэж үзнэ.

## 5. Production Database Status

`legacy_x_plugin_ready_contracts` additive migration нь 2026-08-24-нд Legacy-X production Supabase project (`htfkfkykvrxyrprrlkwq`) дээр амжилттай apply болсон. Энэ нь `server_live_match_snapshots` дээр v1 schema/revision/captured/spectator metadata, receipt table, duplicate болон out-of-order snapshot-г шүүдэг service-role RPC нэмсэн. Existing server, player, skinchanger, review, match record устгаагүй.

## 6. Анхаарах Security Finding

Read-only production schema audit-аар legacy `users`, `user_sessions`, `player_stats`, wallet, moderation, feedback, `api_tokens`, audit зэрэг **24 хуучин table дээр RLS disabled** байгааг илрүүлсэн. Шинэ plugin-ready table-ууд RLS enabled бөгөөд browser role-оос revoke хэвээр байна.

Энэ legacy RLS асуудлыг **энэ өөрчлөлтөөр автоматаар зассангүй**. RLS-г policy-гүйгээр шууд асаавал existing Root API болон login flow тасрах эрсдэлтэй. Тусдаа audited migration дээр least-privilege policy гаргаж, staging-д шалгасны дараа apply хийх шаардлагатай. [Supabase Row Level Security guide](https://supabase.com/docs/guides/database/postgres/row-level-security)
