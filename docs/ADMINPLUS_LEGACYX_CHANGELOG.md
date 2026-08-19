# LEGACY-X AdminPlus — Өөрчлөлтийн тайлан

## Товч дүгнэлт

LEGACY-X repository-д `adminplus/` нэртэй тусгаарлагдсан production module нэмэгдсэн. Энэ module нь `dede177/cs2-admin-plus` upstream-ийн React dashboard, Express RCON backend болон CounterStrikeSharp plugin architecture-ийг суурь болгосон [1]. Үндсэн public LEGACY-X frontend/API-ийг шууд RCON secret-тэй хольж хутгалгүй, admin control panel-ийг тусдаа staff-only surface болгон байрлуулах шийдэл сонгосон.

## Яг юу нэмэгдсэн болон өөрчлөгдсөн бэ?

| Area | LEGACY-X-д зориулсан өөрчлөлт | Production benefit |
|---|---|---|
| Repository layout | `adminplus/backend`, `adminplus/frontend`, `adminplus/plugin`, `adminplus/docs` нэмсэн | Upstream code, community customization, release artifact тусгаарлагдана |
| Environment | `adminplus/backend/.env.example` болон local ignored `.env` үүсгэсэн | RCON, CORS, Supabase, audit, Discord, proxy contract нэг дор төвлөрнө |
| Database | `supabase/legacy_x_adminplus.sql` migration нэмсэн | Admin action history `legacy_x.adminplus_audit_logs` table-д хадгалагдана |
| Authentication | Constant-time API secret compare, request ID, IP window rate limit нэмсэн | Secret timing leak болон casual brute-force эрсдэл багасна |
| RCON safety | Raw `/api/rcon` default-аар disabled; newline/length guard-тэй | Browser-аас arbitrary command ажиллуулах surface багасна |
| Command safety | userid, amount, HP, team, weapon, map, workshop ID validation/allowlist нэмсэн | Command injection болон malformed action-оос хамгаална |
| Audit | Successful action бүр Supabase REST insert хийх боломжтой | Staff action traceability болон incident review боломжтой |
| Discord | Optional webhook embed notifier нэмсэн | Staff channel-д амжилттай admin action мэдэгдэнэ |
| CORS/runtime | Explicit frontend origin, `127.0.0.1` binding, trust proxy, body limit, graceful shutdown | Nginx + PM2 production topology-д нийцнэ |
| Frontend | `VITE_ADMINPLUS_API_BASE` болон `ADMINPLUS_BACKEND_ORIGIN` configurable болгосон | Same-origin болон separate API subdomain хоёр topology дэмжинэ |
| Plugin branding | Module metadata, startup log, reply prefix-ийг LEGACY-X болгосон; version `1.1.0-legacyx` | Server log болон in-game command output community-тай нийцнэ |
| Operations | Root `package.json`-д AdminPlus install/build/start/plugin scripts нэмсэн | Нэг repository-оос repeatable deployment хийх боломжтой |
| Documentation | Production, frontend, Discord runbook-ууд нэмсэн | Admin болон DevOps handover хийхэд бэлэн |

## Upgrade хийсэн хэсгүүд

Upstream хувилбарын үндсэн feature contract хадгалагдсан: player info, respawn, team management, money, weapon, HP, freeze/unfreeze, strip weapons, god, slap, match actions болон map selection хэвээр байна. Харин LEGACY-X production-д шаардлагатай boundary-уудыг өргөтгөсөн. Ялангуяа arbitrary cvar болон raw RCON нь default-аар хаалттай, player action input нь numeric/allowlist validation-тэй, мөн command амжилттай болсон үед audit/Discord notification салангид ажиллана.

Dependency талд backend `npm audit --omit=dev --audit-level=high` 0 vulnerability болсон. Frontend audit мөн 0 vulnerability гэж шалгагдсан. Upstream repository өөрөө 2026-07-17-ны `0068482` commit дээр байсан бөгөөд энэ forked integration дээр community-specific production hardening нэмэгдсэн [1].

## Database холболтын шийдэл

LEGACY-X-ийн одоо ашиглаж буй Supabase `legacy_x` schema-г хадгалсан. AdminPlus backend нь service-role key-г browser-т илгээхгүй; зөвхөн server-side Supabase REST insert ашиглаж `adminplus_audit_logs` table-д мөр нэмнэ. RLS enable хийж, `anon` болон `authenticated` role-д access өгөөгүй; `service_role`-д шаардлагатай insert/select grant үлдээсэн.

Энэ нь AdminPlus-ийг үндсэн LEGACY-X user/session table-тай шууд холбож staff authorization хийсэн гэсэн үг биш. Одоогийн API secret нь staff-only operational guard бөгөөд production-д Nginx/VPN/SSO эсвэл нэмэлт admin access layer-тай хамт ашиглах ёстой. Хэрэв community нь Steam-authenticated staff role-ийг шууд ашиглахыг хүсвэл дараагийн upgrade-д LEGACY-X `is_staff` session-ийг AdminPlus reverse proxy дээр verify хийхээр тусад нь хэрэгжүүлнэ.

## Frontend холболтын шийдэл

Recommended topology нь `admin.legacyx.cc` дээр AdminPlus UI болон API-г same-origin serve хийх явдал. Тусдаа static host шаардлагатай үед `VITE_ADMINPLUS_API_BASE=https://admin-api.legacyx.cc/api` build-time variable ашиглаж болно. Existing public frontend рүү AdminPlus-ийг embed хийхгүй; staff-only link эсвэл separate admin domain ашиглах нь RCON secret болон public cookie boundary-г цэвэр хадгална.

## Discord холболтын шийдэл

Одоогийн хувилбар нь Discord-аас CS2 command хүлээж авах bot биш. Харин dashboard-аас амжилттай болсон admin action-ийг configured Discord webhook рүү embed хэлбэрээр мэдэгддэг outbound-only integration юм. Энэ нь bot token болон inbound command verification шаардлагагүй бөгөөд webhook URL-г backend `.env`-д server-only хадгална.

## Шалгалтын үр дүн

| Test | Result |
|---|---|
| Backend JS `node --check` | Passed |
| AdminPlus frontend Vite production build | Passed |
| CounterStrikeSharp .NET 8 Release build | Passed, 0 warning, 0 error |
| LEGACY-X `pnpm check` | Passed |
| Existing self-contained unit tests | Passed, 7/7 |
| AdminPlus health/auth smoke test | Passed: health 200, unauthenticated API 401 |
| Backend production dependency audit | Passed: 0 vulnerabilities |
| Full repository `pnpm test` | Not green in sandbox because existing credential-dependent tests require real `JWT_SECRET`, Supabase credentials and Steam Web API key; this is environment setup failure, not an AdminPlus assertion failure |

Full `pnpm test`-ийг production credentials-гүйгээр зориуд ногоон гэж тэмдэглээгүй. Existing integration test-үүдийг бодит staging Supabase болон Steam credentials-тэй VPS/CI secret context дотор ажиллуулах ёстой.

## Үлдсэн production action items

| Priority | Action |
|---|---|
| P0 | Real RCON host/port/password, Supabase service-role key, API secret-ийг VPS secret store `.env`-д оруулах |
| P0 | Supabase migration apply хийх |
| P0 | CS2 host дээр built `AdminPlus.dll` байрлуулж plugin load шалгах |
| P0 | Nginx HTTPS domain болон staff-only access layer тохируулах |
| P1 | Discord staff webhook үүсгэж staging channel дээр test хийх |
| P1 | Production Supabase/Steam credentials-тэй existing integration suite ажиллуулах |
| P2 | Steam/LEGACY-X `is_staff` session-ийг API secret-ийн оронд эсвэл дээр нь холбох |
| P2 | Олон CS2 server хэрэгтэй бол instance-specific env болон server selector нэмэх |

## References

[1]: https://github.com/dede177/cs2-admin-plus "dede177/cs2-admin-plus upstream Admin Plus panel"
[2]: https://github.com/roflmuffin/CounterStrikeSharp "CounterStrikeSharp framework"
[3]: https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks "Discord webhook documentation"
