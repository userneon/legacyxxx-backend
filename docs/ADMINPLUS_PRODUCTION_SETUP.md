# LEGACY-X AdminPlus — Production Setup Runbook

**Зорилго.** Энэ module нь LEGACY-X community-ийн CS2 серверийг browser дээрээс удирдах AdminPlus dashboard, RCON bridge, CounterStrikeSharp plugin, Supabase audit logging болон optional Discord notification-ийг нэг deployment contract-д оруулна. Upstream архитектур нь frontend → Express API → RCON → CS2 сервер гэсэн урсгалтай бөгөөд plugin нь player-specific `sm_*` command-уудыг бүртгэдэг [1].

> **Чухал:** `RCON_PASSWORD`, `API_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, Discord webhook token зэрэг нууц утгыг GitHub-д хэзээ ч commit хийхгүй. Repository дахь `.env.example` нь зөвхөн placeholder; production `.env` нь VPS дээр үүснэ.

## 1. Production architecture

| Component | LEGACY-X deployment role | Recommended exposure |
|---|---|---|
| `legacyxxx-frontend` | Одоогоор хоосон; ирээдүйн React/Vite dashboard | Дараа нь HTTPS staff-only domain |
| `legacyxxx-backend/adminplus/backend` | Express API, auth guard, RCON client, audit/Discord bridge | `127.0.0.1:3001`, Nginx-ээр proxy хийх |
| `legacyxxx-plugins/adminplus/plugin/AdminPlus` | CS2 server дээр ажиллах CounterStrikeSharp command bridge | CS2 host доторх plugin folder |
| Supabase `legacy_x.adminplus_audit_logs` | Admin action history | Server-only service role access |
| Discord webhook | Optional action notification | Backend `.env`-д хадгалсан webhook URL |

## 2. Prerequisites

CS2 host дээр Metamod:Source болон CounterStrikeSharp суусан, RCON зөвхөн private/VPS network-ээс хүрдэг, мөн plugin build хийхэд .NET 8 SDK бэлэн байна. Upstream AdminPlus-ийн documented requirements нь Node.js 18+, CS2 RCON, CounterStrikeSharp болон .NET 8 SDK юм [1]. LEGACY-X repository-ийн одоогийн runtime нь Node.js 20–22 хүрээнд зориулагдсан тул AdminPlus backend-ийг мөн Node.js 20 эсвэл түүнээс шинэ LTS runtime дээр ажиллуулна.

## 3. Database migration

Эхлээд Supabase SQL editor эсвэл migration pipeline-ээр `supabase/legacy_x_adminplus.sql` файлыг ажиллуулна.

```bash
# Supabase migration pipeline ашигладаг бол repository-ийн ердийн workflow-оор ажиллуулна.
# SQL editor ашигладаг бол файлын агуулгыг нэг удаа бүхлээр нь apply хийнэ.
```

Migration нь `legacy_x.adminplus_audit_logs` table, `created_at` болон `action` index, RLS enable, мөн `service_role`-д зөвхөн шаардлагатай grant-уудыг үүсгэнэ. Browser талд service-role key огт очихгүй; зөвхөн AdminPlus backend Supabase REST endpoint рүү server-side хүсэлт явуулна.

## 4. Environment setup

```bash
cd /srv/legacyxxx-backend
cp adminplus/backend/.env.example adminplus/backend/.env
chmod 600 adminplus/backend/.env
${EDITOR:-vi} adminplus/backend/.env
```

Production-д дараах утгуудыг бодит secret-ээр солино.

| Variable | Required | Production meaning |
|---|---:|---|
| `RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD` | Yes | CS2 server-ийн RCON connection |
| `API_SECRET` | Yes | Dashboard API-ийн 32+ character private secret |
| `FRONTEND_URL` | Yes | `https://admin.legacyx.cc` зэрэг зөвшөөрөгдсөн origin; олон бол comma-separated |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Yes when audit enabled | LEGACY-X-ийн server-only database access |
| `LEGACYX_DB_SCHEMA`, `LEGACYX_AUDIT_TABLE` | Yes | Default: `legacy_x`, `adminplus_audit_logs` |
| `LEGACYX_AUDIT_ENABLED` | Recommended `true` | Admin action history хадгалах эсэх |
| `DISCORD_WEBHOOK_ENABLED`, `DISCORD_WEBHOOK_URL` | Optional | Successful admin action-уудыг Discord channel-д мэдэгдэх |
| `ALLOW_RAW_RCON` | `false` | Generic RCON endpoint-ийг production-д хаалттай байлгах |

`.env`-ийн placeholder утгуудыг үлдээж production process асаахгүй. `LEGACYX_AUDIT_ENABLED=true` үед Supabase хоёр variable хоосон байвал backend startup дээр зориуд зогсоно.

## 5. Install and build

```bash
cd /srv/legacyxxx-backend
pnpm install --frozen-lockfile
pnpm build
pnpm adminplus:install

cd /srv/legacyxxx-plugins/adminplus/plugin/AdminPlus
dotnet build -c Release
```

Plugin build-ийн output нь `adminplus/plugin/AdminPlus/bin/Release/net8.0/AdminPlus.dll` байна. CS2 host дээр дараах folder руу зөвхөн build болсон DLL-г байрлуулна.

```text
csgo/addons/counterstrikesharp/plugins/AdminPlus/AdminPlus.dll
```

Дараа нь CS2 server restart эсвэл RCON-оор plugin reload хийнэ.

```text
css_plugins unload AdminPlus
css_plugins load AdminPlus
```

Startup log-д `[LEGACY-X AdminPlus] Loaded — production command bridge ready.` гэж харагдах ёстой. Plugin нь upstream-ийн player info, team, money, weapon, HP, freeze, god, slap зэрэг dashboard-ийн command contract-ийг хадгалсан.

## 6. Process management

AdminPlus backend-ийг LEGACY-X API-тай заавал нэг process болгох шаардлагагүй. Security болон failure isolation-ийн хувьд тусдаа PM2 process болгохыг зөвлөж байна.

```bash
cd /srv/legacyxxx-backend
pm2 start adminplus/backend/src/index.js --name legacy-x-adminplus --cwd /srv/legacyxxx-backend --update-env
pm2 save
pm2 startup
```

Health check:

```bash
curl -fsS http://127.0.0.1:3001/health
```

Expected response нь `service: "legacy-x-adminplus"` болон `audit: true` талбаруудыг агуулна. RCON холболт амжилттай бол process log-д `[AdminPlus] RCON connected ...` гарна.

## 7. Nginx reverse proxy

`admin.legacyx.cc` domain-ийг AdminPlus process руу зөвхөн HTTPS-ээр proxy хийнэ. Nginx-ийн TLS certificate болон firewall rule нь deployment-ийн existing standard-аар удирдагдана.

```nginx
server {
    listen 443 ssl http2;
    server_name admin.legacyx.cc;

    # ssl_certificate and ssl_certificate_key are managed by the VPS standard.

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

AdminPlus backend-ийн `HOST=127.0.0.1` тохиргоог public `0.0.0.0` болгож өөрчлөхгүй. RCON port болон AdminPlus API port-ийг internet firewall дээр нээхгүй.

## 8. Production verification

| Check | Command or expected result |
|---|---|
| Frontend repository | `legacyxxx-frontend` intentionally remains empty until frontend work begins |
| Backend health | `curl -fsS https://admin.legacyx.cc/health` returns `ok: true` |
| Auth guard | `/api/players` without `x-api-secret` returns HTTP 401 |
| Raw RCON guard | `/api/rcon` returns HTTP 403 when `ALLOW_RAW_RCON=false` |
| Plugin | CS2 log contains LEGACY-X AdminPlus startup message |
| Player info | Authenticated `GET /api/players` returns `players` and `map` |
| Database audit | Successful action inserts one row in `legacy_x.adminplus_audit_logs` |
| Discord | When enabled, successful action posts one embed to the configured staff channel |

## References

[1]: https://github.com/dede177/cs2-admin-plus "dede177/cs2-admin-plus — upstream Admin Plus panel, backend and CounterStrikeSharp plugin"
[2]: https://github.com/roflmuffin/CounterStrikeSharp "CounterStrikeSharp — CS2 plugin framework"
