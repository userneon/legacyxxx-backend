# LEGACY-X Backend

`legacyxxx-backend` нь LEGACY-X community-ийн API-only repository юм. Энэ repository нь Steam authentication, Supabase `legacy_x` database access, community API routes, production runtime config болон AdminPlus RCON bridge-ийг агуулна. Frontend source энд байхгүй; frontend repository-г одоогоор хоосон нөөц repository хэлбэрээр үлдээсэн.

## Repository boundary

| Repository | Responsibility |
|---|---|
| `legacyxxx-backend` | API, authentication, database migrations, AdminPlus backend/RCON bridge, production operations |
| `legacyxxx-plugins` | CS2 CounterStrikeSharp plugin DLL source болон build/deploy documentation |
| `legacyxxx-frontend` | Одоогоор intentionally empty; дараагийн frontend implementation энд орно |

## Local setup

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm check
pnpm build
```

API server нь `127.0.0.1:3000` дээр ажиллах бөгөөд production-д Nginx-ээр HTTPS domain руу proxy хийнэ. Frontend/static serving зориуд хасагдсан; API route-ууд `/api/v1/*`, health check `/health` дээр байна.

## AdminPlus backend bridge

AdminPlus backend source нь `adminplus/backend` дотор байна. RCON secret, API secret, Supabase service-role key болон optional Discord webhook-ийг зөвхөн `adminplus/backend/.env` дотор хадгална.

```bash
pnpm adminplus:install
pnpm adminplus:start
```

AdminPlus-ийн бүрэн runbook нь [`docs/ADMINPLUS_PRODUCTION_SETUP.md`](docs/ADMINPLUS_PRODUCTION_SETUP.md), frontend холболтын boundary нь [`docs/ADMINPLUS_FRONTEND_CONNECTION.md`](docs/ADMINPLUS_FRONTEND_CONNECTION.md), Discord setup нь [`docs/ADMINPLUS_DISCORD_CONNECTION.md`](docs/ADMINPLUS_DISCORD_CONNECTION.md) файлд байна.

## Database

`supabase/legacy_x_adminplus.sql` migration нь `legacy_x.adminplus_audit_logs` table болон service-role grants үүсгэнэ. Migration-ийг production Supabase project дээр apply хийсний дараа `LEGACYX_AUDIT_ENABLED=true` болгож backend асаана.

## Production safety

`.env` болон бүх real secret-ийг commit хийхгүй. RCON host/port-ийг public internet-д нээхгүй, backend-ийг private listener дээр ажиллуулж, Nginx/VPN/staff-only access layer ашиглана. AdminPlus-ийн raw RCON endpoint default-аар disabled.
