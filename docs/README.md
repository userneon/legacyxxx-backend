# legacyxxx-backend: баримтын индекс

Эхлээд **[MANUAL_MN.md](MANUAL_MN.md)** (энэ repo-ийн гарын авлага: ажиллуулах, deploy, тохиргоо, API, DB, алдаа засах).
Доорх хүснэгт нь бусад баримтыг ангилж харуулна. Гарчигийн өмнөх тэмдэглэгээ: **✓** одоогийн, **⚠** хэсэгчлэн хуучирсан, **📜** түүх/тайлан.

## Суулгах, ажиллуулах

| Баримт | Тайлбар |
|---|---|
| [MANUAL_MN.md](MANUAL_MN.md) ✓ | Бүрэн гарын авлага |
| [../VPS_DEPLOY.md](../VPS_DEPLOY.md) ⚠ | VPS + Nginx + PM2; `.env` хүснэгтэд `STATIC_ASSET_BASE_URL` дутуу |
| [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) ✓ | Production deploy-ийн дэлгэрэнгүй |
| [SKINCHANGER_STATIC_ASSET_HOSTING.md](SKINCHANGER_STATIC_ASSET_HOSTING.md) ✓ | `static.legacyx.cc` зургийн origin |

## API ба хамгаалалт

| Баримт | Тайлбар |
|---|---|
| [../API.md](../API.md) ✓ | REST API, plugin scope-ууд |
| [API_SECURITY_HARDENING.md](API_SECURITY_HARDENING.md) ✓ | Rate limit, CORS, cookie, token |
| [PLUGIN_READY_CONTRACT_V1.md](PLUGIN_READY_CONTRACT_V1.md) ✓ | Plugin ↔ API гэрээ |
| [FRONTEND_ENDPOINT_ADAPTER_SPEC.md](FRONTEND_ENDPOINT_ADAPTER_SPEC.md) ⚠ | Frontend ↔ API endpoint зураглал |
| [FEATURE_FLAGS.md](FEATURE_FLAGS.md) ✓ | Хойшлуулсан feature-ийн унтраалга |
| [LEGACY_RLS_HARDENING_2026-08-24.md](LEGACY_RLS_HARDENING_2026-08-24.md) 📜 | RLS чангатгал |

## Цол, EXP, match

| Баримт | Тайлбар |
|---|---|
| [RANK_SYSTEM.md](RANK_SYSTEM.md) ✓ | Rank систем |
| [LEADERBOARD_RANK_INTEGRATION.md](LEADERBOARD_RANK_INTEGRATION.md) ⚠ | Leaderboard ба MatchZy холболт |
| [MONTHLY_RANK_RESET.md](MONTHLY_RANK_RESET.md) ✓ | Сарын rank reset |
| [COMMUNITY_PROGRESSION_CLANS.md](COMMUNITY_PROGRESSION_CLANS.md) ⚠ | EXP, level, clan |
| [PLUGIN_RANKED_TELEMETRY_V2.md](PLUGIN_RANKED_TELEMETRY_V2.md) ✓ | Ranked telemetry |
| [UNIFIED_MATCH_SYSTEM_RUNBOOK.md](UNIFIED_MATCH_SYSTEM_RUNBOOK.md) ✓ | Match Core ажиллуулалт |

## Admin, staff, эрх

| Баримт | Тайлбар |
|---|---|
| [STAFF_PANEL.md](STAFF_PANEL.md) ✓ | Staff panel: эрх, action queue |
| [ADMINPLUS_API_ONLY.md](ADMINPLUS_API_ONLY.md) ⚠ | AdminPlus API-only |
| [ADMINPLUS_PRODUCTION_SETUP.md](ADMINPLUS_PRODUCTION_SETUP.md) ⚠ | AdminPlus production |

## Skin

| Баримт | Тайлбар |
|---|---|
| [SKINCHANGER_OPERATOR_RUNBOOK.md](SKINCHANGER_OPERATOR_RUNBOOK.md) ✓ | Catalog ingest, оператор |

## Аудит ба шалгалт 📜

[../AUDIT_2026-09-20.md](../AUDIT_2026-09-20.md), [PLUGIN_GAP_AUDIT_2026-08-24.md](PLUGIN_GAP_AUDIT_2026-08-24.md),
[PRODUCTION_DB_AUDIT.md](PRODUCTION_DB_AUDIT.md), [RANK_EXP_AUDIT_2026-08-24.md](RANK_EXP_AUDIT_2026-08-24.md),
[ROLE_MIGRATION_AUDIT.md](ROLE_MIGRATION_AUDIT.md), [USER_ROLE_MIGRATION_AUDIT_2026-08-24.md](USER_ROLE_MIGRATION_AUDIT_2026-08-24.md),
[SERVER_LIVE_MATCH_AUDIT_2026-08-24.md](SERVER_LIVE_MATCH_AUDIT_2026-08-24.md), [UNIFIED_MATCH_SYSTEM_AUDIT.md](UNIFIED_MATCH_SYSTEM_AUDIT.md),
[V1_CLEANUP_AUDIT.md](V1_CLEANUP_AUDIT.md)

## Changelog 📜

[ADMINPLUS_LEGACYX_CHANGELOG.md](ADMINPLUS_LEGACYX_CHANGELOG.md), [COMMUNITY_PROGRESSION_CHANGELOG.md](COMMUNITY_PROGRESSION_CHANGELOG.md),
[MONTHLY_RANK_RESET_CHANGELOG.md](MONTHLY_RANK_RESET_CHANGELOG.md), [RANK_ADMINPLUS_CHANGELOG.md](RANK_ADMINPLUS_CHANGELOG.md),
[RECONNECT_CHANGELOG.md](RECONNECT_CHANGELOG.md)

## Бусад

[../MASTER_CONTEXT.md](../MASTER_CONTEXT.md) 📜 (2026-09-20-ны төлөв, хуучирсан), [../todo.md](../todo.md),
[PROMOTION_CODES.md](PROMOTION_CODES.md), [RECONNECT_LAST_PLAYED.md](RECONNECT_LAST_PLAYED.md) 📜 (plugin хаагдсан),
[STEAM_PROFILE_BACKGROUND_FEASIBILITY.md](STEAM_PROFILE_BACKGROUND_FEASIBILITY.md)
