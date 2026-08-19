# LEGACY-X AdminPlus — Repository Split Change Report

## Товч дүгнэлт

LEGACY-X source-ийг гурван private GitHub repository болгон салгасан. `legacyxxx-backend` нь API, authentication, Supabase database, AdminPlus RCON bridge болон operational documentation-г эзэмшинэ. `legacyxxx-plugins` нь CounterStrikeSharp AdminPlus plugin DLL source-г эзэмшинэ. `legacyxxx-frontend` нь одоогоор зориуд хоосон reserved repository байна. AdminPlus-ийн backend/plugin architecture нь `dede177/cs2-admin-plus` upstream дээр суурилсан [1].

## Эцсийн repository mapping

| Repository | Одоогийн агуулга | Production responsibility |
|---|---|---|
| `legacyxxx-backend` | `server`, `shared`, `drizzle`, `supabase`, `adminplus/backend`, docs | API, database, auth, RCON bridge, audit, Discord notifier |
| `legacyxxx-plugins` | `adminplus/plugin/AdminPlus` | CS2 CounterStrikeSharp plugin build/deploy |
| `legacyxxx-frontend` | README болон `.gitignore` בלבד | Одоогоор intentionally empty; дараагийн UI implementation энд эхэлнэ |

## Backend өөрчлөлт

Backend repository-г frontend-гүй API-only болгосон. `server/_core/index.ts` нь Vite/static serving хийхгүй бөгөөд `/api/v1` болон `/health` endpoint ажиллуулна. `package.json`-ийн `build` script нь зөвхөн esbuild API artifact үүсгэнэ. `tsconfig.json` нь client source болон Vite type dependency-г хассан.

AdminPlus backend нь `adminplus/backend` дотор байрлаж, RCON host/password, API secret, Supabase service-role key, CORS origin, audit болон Discord webhook тохиргоог `.env.example`-ээр тодорхойлсон. Real `.env` файл repository-д commit хийгдээгүй.

## Plugins өөрчлөлт

`legacyxxx-plugins` repository-д LEGACY-X branded CounterStrikeSharp AdminPlus plugin тусдаа байрласан. Build нь .NET 8 SDK ашиглана.

```bash
cd adminplus/plugin/AdminPlus
dotnet build -c Release
```

Output DLL-г CS2 server-ийн `csgo/addons/counterstrikesharp/plugins/AdminPlus/AdminPlus.dll` folder-д байрлуулна. Plugin startup log болон command reply prefix LEGACY-X branding-тэй.

## Frontend төлөв

`legacyxxx-frontend` repository-г user-ийн шаардлагын дагуу source code-гүй үлдээсэн. React/Vite dashboard, AdminPlus UI, static assets болон frontend build script оруулаагүй. Дараагийн frontend implementation энэ repository-д эхлэх бөгөөд backend API нь `legacyxxx-backend`-ийн `/api/v1` болон AdminPlus-ийн staff-only API boundary-г ашиглана.

## Production hardening

| Area | Change | Benefit |
|---|---|---|
| API auth | Constant-time API secret compare, request ID, rate limit | Staff API хамгаалалт сайжирна |
| RCON | Raw `/api/rcon` default disabled | Arbitrary command surface багасна |
| Input validation | userid, amount, HP, team, weapon, map, workshop ID allowlist/range validation | Command injection болон malformed action багасна |
| Database | `legacy_x.adminplus_audit_logs` migration | Admin action history хадгална |
| Discord | Optional outbound webhook embed | Staff audit channel notification |
| Runtime | Private host binding, explicit CORS, body limit, graceful shutdown | Nginx + PM2 production topology-д нийцнэ |
| Secret hygiene | `.env` ignore rules, no real values in Git | Credential leakage-ээс хамгаална |

## Шалгалтын үр дүн

| Test | Result |
|---|---|
| `legacyxxx-backend` TypeScript check | Passed |
| `legacyxxx-backend` API-only production build | Passed |
| Backend self-contained unit tests | Passed, 7/7 |
| AdminPlus backend dependency audit | Passed, 0 vulnerabilities |
| `legacyxxx-plugins` .NET 8 Release build | Passed, 0 warnings, 0 errors |
| `legacyxxx-frontend` | Intentionally empty; build хийгдээгүй |

Бодит Supabase, Steam Web API болон RCON credentials оруулаагүй тул credential-dependent integration tests болон live server deployment-г энд ажиллуулаагүй. Production-д migration apply, secret injection, Nginx staff-only access болон plugin load verification үлдсэн.

## References

[1]: https://github.com/dede177/cs2-admin-plus "dede177/cs2-admin-plus upstream Admin Plus panel"
[2]: https://github.com/roflmuffin/CounterStrikeSharp "CounterStrikeSharp framework"
[3]: https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks "Discord webhook documentation"
