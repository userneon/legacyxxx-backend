# legacyxxx-backend: гарын авлага

`api.legacyx.cc`-ийг ажиллуулдаг API. Вэб сайт, Discord bot, CS2 plugin-ууд бүгд энэ API-тай ярьж, API л Supabase
(PostgreSQL, `legacy_x` schema)-тай харилцана.

| Хэсэг | Агуулга |
|---|---|
| [1. Энэ repo юу вэ](#1-энэ-repo-юу-вэ) | Үүрэг, өгөгдлийн урсгал, юу байхгүй |
| [2. Локал дээр ажиллуулах](#2-локал-дээр-ажиллуулах) | Суулгах, ажиллуулах, тест |
| [3. Бүтэц](#3-бүтэц) | Хавтас бүр юу |
| [4. Тохиргоо (`.env`)](#4-тохиргоо-env) | Хувьсагч, feature flag |
| [5. Deploy ба ажиллуулалт](#5-deploy-ба-ажиллуулалт) | VPS, pm2, Nginx, шалгалт |
| [6. Database](#6-database) | Supabase, migration, аюулгүй байдал |
| [7. Нэвтрэлт ба эрх](#7-нэвтрэлт-ба-эрх) | Хэрэглэгч, plugin token, staff |
| [8. API-ийн бүлгүүд](#8-api-ийн-бүлгүүд) | Бүх route бүлгээр |
| [9. Цол ба EXP](#9-цол-ба-exp) | Тооцоо, хязгаар |
| [10. Plugin ба bot хэрхэн холбогддог](#10-plugin-ба-bot-хэрхэн-холбогддог) | Heartbeat, match, дуудлага, update |
| [11. Алдаа засах](#11-алдаа-засах) | Шинж тэмдэг → шалтгаан |
| [12. Хуучирсан зүйлс](#12-хуучирсан-зүйлс) | Баримт дахь зөрүү |
| [13. Бусад баримт](#13-бусад-баримт) | [README.md](README.md) индекс |

---

## 1. Энэ repo юу вэ

```text
Вэб (legacyx.cc) ─┐
Discord bot ──────┼──HTTPS──► api.legacyx.cc (энэ repo) ──► Supabase (legacy_x schema)
CS2 plugin-ууд ───┘
```

- **Нэг Node.js процесс** (Express 5, TypeScript), Nginx-ийн ард, `127.0.0.1:3000`, pm2 (`legacy-x-api`).
- **Цорын ганц** Supabase service-role key эзэмшигч. Браузер, bot, plugin Supabase-д шууд хандахгүй.
- Frontend энд **байхгүй** (`legacyxxx-frontend`), CS2 plugin-ууд ч **байхгүй** (`legacyxxx-plugins`), харин тэдэнтэй ярих гэрээ энд.
- `adminplus/` хавтас хуучин AdminPlus сервис. Одоогийн in-game admin нь `LegacyX-Admin` plugin + энэ API (§7, §10).

## 2. Локал дээр ажиллуулах

Node 22 (багадаа 20.19), npm.

```bash
npm ci                       # package-lock.json-оор суулгана
cp ENVIRONMENT.example .env  # утгуудыг бөглөнө (§4). Production биш бол HTTPS шаардлага унана
npm run dev                  # tsx watch, :3000
npm run check                # tsc --noEmit (typecheck)
npm test                     # vitest run
npm run build                # esbuild → dist/index.js
```

- Тест: **179 pass, 7 skip** (skip нь бодит Supabase хэрэгтэй integration тест). Зарим тест `JWT_SECRET` хүсдэг (тест өөрөө тохируулна).
- `npm run dev` Supabase-д холбогдохын тулд бодит `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` хэрэгтэй. Production-ы түлхүүрийг
  локал компьютерт бүү тавь; тусдаа туршилтын project ашигла.

## 3. Бүтэц

| Зам | Юу |
|---|---|
| `server/_core/index.ts` | Express app: `/health`, `/api/v1` router, rate limit, CORS, cookie |
| `server/_core/security.ts` | Хамгаалалтын middleware (+ тест) |
| `server/legacyX/routes.ts` | Бүх `/api/v1` route (~117) |
| `server/legacyX/ranking.ts` | Цол/EXP-ийн тооцоо (хязгаартай) |
| `server/legacyX/play.ts` | Play хуудасны server card, Quick join |
| `server/legacyX/adminCalls.ts`, `announcements.ts` | Bot-д зориулсан feed |
| `server/legacyX/auth.ts`, `adminAuthorization.ts` | Нэвтрэлт, plugin token, in-game staff эрх |
| `server/legacyX/bans.ts`, `gamePenalties.ts` | Ban, шийтгэл |
| `server/legacyX/supabase.ts` | DB client (service role) |
| `server/legacyX/*.test.ts` | Тест |
| `supabase/*.sql` | Migration-ууд (~58) |
| `scripts/` | `create-api-token.mjs`, `create-game-server.mjs`, `ingest-skinchanger-catalog.mjs`, build тусламж |
| `ops/deploy.sh` | VPS дээр нэг командаар deploy |
| `ecosystem.config.cjs` | pm2 тохиргоо |
| `docs/` | Баримт ([README.md](README.md)) |

## 4. Тохиргоо (`.env`)

`ENVIRONMENT.example`-ийг `.env` болгож хуулна, `chmod 600 .env`. Git-д орохгүй.

| Хувьсагч | Production-д | Тайлбар |
|---|---|---|
| `NODE_ENV` | заавал | `production` |
| `HOST`, `PORT` | заавал | `127.0.0.1`, `3000` |
| `TRUST_PROXY` | заавал | `1` (Nginx нэг hop) |
| `API_RATE_LIMIT_MAX` | заавал | Минутанд IP тус бүр; анхдагч 120 |
| `SUPABASE_URL` | заавал, HTTPS | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | заавал | **Зөвхөн энэ API-д**, хэзээ ч log-д, frontend-д бүү оруул |
| `STEAM_WEB_API_KEY` | заавал | Steam нэр, avatar татах |
| `JWT_SECRET` | заавал, ≥32 тэмдэгт | Session тэмдэглэх |
| `PUBLIC_API_ORIGIN` | заавал, HTTPS | `https://api.legacyx.cc` |
| `STEAM_OPENID_ORIGIN` | заавал, HTTPS | `https://legacyx.cc` (Steam consent дээр харагдах нэр) |
| `FRONTEND_ORIGIN` | заавал, HTTPS | `https://legacyx.cc`, цорын ганц CORS origin |
| `AUTH_COOKIE_DOMAIN` | заавал | `.legacyx.cc` |
| `POST_LOGIN_REDIRECT` | заавал, HTTPS | `https://legacyx.cc/` |
| `STATIC_ASSET_BASE_URL` | заавал, HTTPS | `https://static.legacyx.cc` (skin зураг) |
| `FACEIT_DATA_API_KEY` | сонголт | Profile дээр FACEIT level |
| `STAFF_PANEL_ENABLED`, `CLAN_ENABLED` гэх мэт | сонголт | Яг `true` гэж бичсэн үед л асна ([FEATURE_FLAGS.md](FEATURE_FLAGS.md)) |

Production-д шаардлагатай хувьсагч дутуу, эсвэл HTTPS биш бол API **эхлэхгүй** (`validateProductionRuntime`).

## 5. Deploy ба ажиллуулалт

### Эхний удаа (Ubuntu VPS)

Дэлгэрэнгүй: [../VPS_DEPLOY.md](../VPS_DEPLOY.md). Товчоор: Node 22, pm2, clone, `npm ci`, `.env`, `npm run build`,
`pm2 start ecosystem.config.cjs --env production`, `pm2 save`, `pm2 startup`.

### Дараагийн release бүр

```bash
cd ~/legacyxxx-backend
bash ops/deploy.sh
```

Скрипт: `git pull --ff-only main` → `npm ci` → `npm run check` → `npm run build` → pm2 reload → `/health` шалгах
(15 удаа) → амжилттай бол Discord-д "API updated" мэдэгдэл. `.env` байхгүй бол эхлэхээс өмнө зогсоно.

### Nginx

`api.legacyx.cc` → `proxy_pass http://127.0.0.1:3000` (`Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` дамжуулна).
Өөрчилсний дараа `sudo nginx -t && sudo systemctl reload nginx`.

### Шалгалт, log

```bash
curl -fsS http://127.0.0.1:3000/health          # {"ok":true,"service":"legacy-x-backend"}
curl -fsS https://api.legacyx.cc/api/v1/public/overview
pm2 status
pm2 logs legacy-x-api --lines 100
```

Rollback: өмнөх commit руу `git checkout <commit>` → `npm ci && npm run build` → `pm2 reload ecosystem.config.cjs --env production --update-env`.
(Дараа нь `main` руу буцахаа бүү мартаарай.)

## 6. Database

- Supabase PostgreSQL, **`legacy_x` schema**. `anon`, `authenticated` эрхтэй хүн хүснэгтэд шууд хандахгүй; зөвхөн `service_role` (энэ API).
- Хүснэгт бүр дээр RLS идэвхтэй. Шинэ хүснэгт нэмэхдээ ижил загварыг дага (жишээ: `supabase/legacy_x_announcements.sql`):
  `REVOKE ALL … FROM anon, authenticated; ALTER TABLE … ENABLE ROW LEVEL SECURITY; GRANT … TO service_role;`.
- **Migration** нь `supabase/legacy_x_*.sql`. Автомат runner **байхгүй**: Supabase SQL editor эсвэл CLI-аар гараар apply хийнэ.
  Production-д аль хэдийн apply хийсэн; шинэ файл нэмэхдээ `IF NOT EXISTS` хэрэглэж, дахин ажиллуулахад аюулгүй байлга.
- Байнга хэрэглэгддэг гол хэсгүүд:

| Бүлэг | Migration (жишээ) |
|---|---|
| Хэрэглэгч, role, staff | `legacy_x_user_roles`, `legacy_x_staff_panel`, `legacy_x_game_staff_authorization` |
| Цол, EXP | `legacy_x_competitive_rank_exp`, `legacy_x_rank_system_v1`, `legacy_x_monthly_rank_reset` |
| Match | `legacy_x_match_core`, `legacy_x_match_rounds`, `legacy_x_server_live_match` |
| Server, heartbeat | `legacy_x_server_heartbeat`, `legacy_x_reconnect`, `legacy_x_reconnect_server_capacity` |
| Ban, шийтгэл | `legacy_x_adminplus`, `legacy_x_admin_system` |
| Bot-ын feed | `legacy_x_admin_calls`, `legacy_x_admin_calls_reports`, `legacy_x_announcements`, `legacy_x_discord_links` |
| Skin | `legacy_x_skinchanger` + `…_catalog_fast_path`, `…_stateless_pull` |
| Аюулгүй байдал | `legacy_x_legacy_rls_hardening`, `legacy_x_revoke_public_definer_functions`, `legacy_x_service_role_grants` |

- Production-д DDL хийхээсээ өмнө өөрчлөлт нэмэлт (additive) эсэхийг шалга; устгах/өөрчлөх бол эхлээд нөөцөл.

## 7. Нэвтрэлт ба эрх

Гурван өөр "хэн" байдаг:

| Хэн | Яаж | Cookie/Header | Хаана |
|---|---|---|---|
| **Тоглогч** | Steam OpenID (`/auth/steam`) → JWT + эргэх refresh token | HTTP-only cookie `legacyx_access_token`, `legacyx_refresh_token` (`.legacyx.cc`) | `/profile`, `/skinchanger`, `/feedback` гэх мэт |
| **Plugin / bot** | Scope-той token | `Authorization: Bearer <token>` (SHA-256 хэшээр хадгална, түүхий token хадгалдаггүй) | `/plugin/*` |
| **Staff** | `/staffpanel` дээр шинэ Steam нэвтрэлт; идэвхтэй `OWNER`/`MANAGER` | `legacyx_staff_session` (тусдаа cookie) | `/staffpanel/*` |

- **Token үүсгэх:** `node --env-file=.env scripts/create-api-token.mjs <нэр> <scope…>` (түүхий token нэг л удаа харагдана).
- **CS2 машин:** `node --env-file=.env scripts/create-game-server.mjs <host> "27015:competitive_5v5:LEGACY-X #1" …` нэг token + `.env` үүсгэнэ.
- **Scope-ууд:** `admin:read`, `announce:write`, `bans:read`, `bans:write`, `community:write`, `discord:link`, `maps:write`, `matches:write`, `servers:write`, `skinchanger:read`, `stats:write`.
- In-game admin эрх зөвхөн DB-ийн staff + server-ийн томилгооноос (`/plugin/admin/authorizations`); game server өөрөө жагсаалт хадгалдаггүй.
- Вэбийн нууцлал: staff панель action нь бодит shell/RCON биш, зөвхөн тодорхой төрлийн "queue" мөр ([STAFF_PANEL.md](STAFF_PANEL.md)).

## 8. API-ийн бүлгүүд

Бүгд `/api/v1` дор. Дэлгэрэнгүй: [../API.md](../API.md) (нэмж, ихэнх хуучин store/wallet endpoint унтраалттай).

| Бүлэг | Route (товч) | Хэн |
|---|---|---|
| Нэвтрэлт | `/auth/steam`, `/auth/steam/callback`, `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/steam/discord/:token` | нийтийн/тоглогч |
| Нийтийн | `/public/overview`, `/public/servers`, `/public/servers/:id/live-match`, `/public/killfeed`, `/public/competitive/leaderboard`, `/public/features` | нийтийн |
| Play | `/play/:mode/servers`, `/play/:mode/quick-join` (`mode`: 5x5, fun, pro) | нийтийн |
| Профайл | `/profile/:userId` (+ `/overview`, `/stats`, `/matches`, `/penalties`, `/faceit`), `PUT /profile/me…` | нийтийн/тоглогч |
| Шийтгэл | `/penalties`, `/penalties/stats`, `/moderation/penalties` | нийтийн |
| Skinchanger | `/skinchanger/catalog`, `/loadout` (GET/PUT/DELETE entry) | тоглогч |
| Тэмцээн | `/tournaments`, `…/register`, `…/check-in` | тоглогч |
| Clan | `/clans…` (`CLAN_ENABLED`) | тоглогч |
| Feedback, мэдэгдэл | `/feedback`, `/notifications`, `/settings/notifications` | тоглогч |
| Staff panel | `/staffpanel/access`, `/overview`, `/staff`, `/actions`… | staff |
| Plugin | `/plugin/servers/heartbeat`, `/plugin/live-match/snapshots`, `/plugin/matchzy/events`, `/plugin/match-core/events`, `/plugin/bans…`, `/plugin/penalties…`, `/plugin/admin-calls`, `/plugin/announcements`, `/plugin/killfeed/events`, `/plugin/skinchanger/loadout`, `/plugin/discord/links…` | plugin/bot token |
| Health | `GET /health` (API-ийн язгууртай), `GET /api/v1/health` | нийтийн |

## 9. Цол ба EXP

`server/legacyX/ranking.ts` (хувилбар `legacyx-exp-1.0`). Үндсэн тоо:

| Утга | Хэмжээ |
|---|---|
| Эхлэх EXP | 1000 |
| Pro League нээгдэх / хадгалах | 1400 / 1350 |
| Calibration | эхний 10 match (өсөлтийн хязгаар 45 → 90) |
| Тоологдох match | ≥8 хүн, ≥13 раунд, оролцоо ≥50% |
| Leaver торгууль | −25 |
| Өдрийн өсөлтийн хязгаар | 150 (давсан нь ×¼) |
| Долоо хоногийн өсөлтийн хязгаар | 600 (давсан нь ×¼) |
| Сарын reset | UTC сарын эхэнд (EXP/level reset хийгдэхгүй, rank season л) |

Дэлгэрэнгүй: [RANK_SYSTEM.md](RANK_SYSTEM.md), [MONTHLY_RANK_RESET.md](MONTHLY_RANK_RESET.md), frontend-ийн `docs/design/RANK-SYSTEM.md`.
Хязгаарыг өөрчлөх бол `ranking.ts` + тест (`ranking.test.ts`) + frontend-ийн хязгаарын UI хамт өөрчлөгдөнө.

## 10. Plugin ба bot хэрхэн холбогддог

| Урсгал | Хэрхэн |
|---|---|
| Server төлөв | `LegacyX-Status` 30 секунд тутам `POST /plugin/servers/heartbeat` + `/plugin/live-match/snapshots` → Play хуудас, home тоо, Discord самбар |
| Match дүн, EXP | MatchZy → `/plugin/matchzy/events`, Match Core → `/plugin/match-core/events` |
| Ban, шийтгэл | Discord `/ban`, in-game, вэб → `/plugin/bans…`, `/plugin/penalties…`; server `/plugin/bans/check`-ээр шалгана |
| Дуудлага, report | `!calladmin`, `!callmanager`, `!report` → `POST /plugin/admin-calls`; bot `GET /plugin/admin-calls?after=<id>` |
| Update мэдэгдэл | Deploy script → `POST /plugin/announcements` (`announce:write`); bot `GET …?after=<id>` |
| Discord ↔ Steam | `/plugin/discord/link-requests` → нэг удаагийн холбоос → `…/links` |
| Skin | Вэб `PUT /skinchanger/loadout` → plugin `GET /plugin/skinchanger/loadout` |

Bot-ын feed-үүд (`admin-calls`, `announcements`): `?after` байхгүй бол зөвхөн `latestId` буцаана (шинэ channel одооноос эхэлнэ); 24 цагаас хуучныг өгөхгүй.

## 11. Алдаа засах

| Шинж тэмдэг | Шалтгаан | Засах |
|---|---|---|
| API эхлэхгүй: `Missing required environment variable` | `.env` дутуу (жишээ нь `STATIC_ASSET_BASE_URL`) | `ENVIRONMENT.example`-тэй харьцуулж нөхнө |
| `… must use HTTPS in production` | URL `http://` | HTTPS болгоно |
| `JWT_SECRET must contain at least 32 characters` | Богино нууц | ≥32 тэмдэгт |
| `502 Bad Gateway` | API унтарсан / pm2 унасан | `pm2 status`, `pm2 logs legacy-x-api`; Nginx `proxy_pass` порт |
| 500 + PostgREST schema алдаа | `legacy_x` schema-д эрх/cache | `legacy_x_service_role_grants.sql`; Supabase дээр schema cache reload |
| Plugin `401/403` | Token буруу эсвэл scope дутуу | `create-api-token.mjs` дахин, зөв scope |
| Нэвтэрсний дараа cookie тогтохгүй | `AUTH_COOKIE_DOMAIN`, `FRONTEND_ORIGIN` буруу | `.legacyx.cc`, `https://legacyx.cc`; frontend `credentials: "include"` |
| Skin зураггүй | `static.legacyx.cc` хоосон | [SKINCHANGER_STATIC_ASSET_HOSTING.md](SKINCHANGER_STATIC_ASSET_HOSTING.md) |
| Play хуудас хоосон | Heartbeat ирэхгүй | Game server дээр `LegacyX-Status` log, `.env` token |
| Deploy: `npm ci` унана | Lockfile `package.json`-той зөрсөн | `npm install` хийж `package-lock.json`-ыг commit |

## 12. Хуучирсан зүйлс

Эдгээр нь одоогийн байдлаас зөрүүтэй, найдахгүй байх:

- `README.md` (язгуур): "frontend-гүй, AdminPlus RCON bridge" гэж бичсэн; `adminplus/backend` ба `pnpm` командууд хуучин. §2 ба §5-г ашигла.
- `MASTER_CONTEXT.md`: 2026-09-20-ны төлөв (frontend салаа, feature flag). Түүх гэж үз.
- `VPS_DEPLOY.md`: `.env` хүснэгтэд `STATIC_ASSET_BASE_URL` байхгүй; `NETLIFY_STEAM_CALLBACK_PROXY.toml` файл repo-д байхгүй. §4-ийг ашигла.
- `API.md`: store/wallet endpoint-ууд унтраалттай (`SHOP_ENABLED`, `WALLET_ENABLED`).

## 13. Бусад баримт

Бүх баримтын ангилсан индекс: **[README.md](README.md)**.
