# LEGACY-X Frontend → Backend холболт

`legacyxxx-frontend` repository-г одоогоор зориуд хоосон үлдээсэн. Тиймээс энэ шатанд frontend build, React route болон AdminPlus dashboard source production-д шилжээгүй; backend болон plugin integration нь тусдаа ажиллахад бэлэн байна.

## Repository boundary

| Repository | Одоогийн үүрэг |
|---|---|
| `legacyxxx-backend` | LEGACY-X API, authentication, database, AdminPlus RCON/audit backend |
| `legacyxxx-plugins` | CounterStrikeSharp AdminPlus plugin DLL source |
| `legacyxxx-frontend` | Empty reserved repository; дараагийн UI implementation энд эхэлнэ |

## Одоогийн backend topology

```text
Staff tool / future frontend
          │ x-api-secret
          ▼
legacyxxx-backend
  /api/v1/*   LEGACY-X community API
  /health     API health
  AdminPlus backend :3001  RCON/audit/Discord bridge
          │
          ├── Supabase legacy_x
          └── CS2 RCON → legacyxxx-plugins/AdminPlus.dll
```

Backend repository нь static frontend serve хийхгүй. `server/_core/index.ts` нь зөвхөн API route болон `/health` endpoint-ийг ажиллуулдаг API-only bootstrap болсон. Энэ нь frontend repository-г дараа нь өөр framework эсвэл тусдаа deployment-аар эхлүүлэхэд backend-ийн release cycle-д нөлөөлөхгүй.

## Frontend эхлүүлэх үеийн contract

Frontend implementation эхлэх үед browser API client нь дараах endpoint boundary-г ашиглана.

| Operation | Endpoint | Auth |
|---|---|---|
| LEGACY-X community API | `/api/v1/*` | Existing LEGACY-X session/bearer cookie |
| AdminPlus player list | AdminPlus backend `/api/players` | `x-api-secret` staff guard |
| AdminPlus server controls | AdminPlus backend `/api/server/*` | `x-api-secret` staff guard |
| Health | `/health` | Public readiness check |

AdminPlus dashboard-ийг public frontend-д шууд embed хийхгүй. Recommended production topology нь `admin.legacyx.cc` staff-only domain-оор Nginx proxy хийж, AdminPlus backend-ийг `127.0.0.1:3001` дээр ажиллуулах явдал. Frontend repository хэрэгжиж дууссаны дараа `FRONTEND_URL`-ийг backend `.env` дээр яг тэр HTTPS origin-оор тохируулна.

## Future Vite/React integration

Ирээдүйд React/Vite dashboard нэмэхдээ API base-ийг hard-code хийхгүй, environment variable ашиглана.

```dotenv
VITE_LEGACYX_API_BASE=https://api.legacyx.cc/api/v1
VITE_ADMINPLUS_API_BASE=https://admin-api.legacyx.cc/api
```

`SUPABASE_SERVICE_ROLE_KEY`, `RCON_PASSWORD`, `API_SECRET` зэрэг server-only secret-ийг frontend bundle, `.env.example`-ийн бодит утга, browser localStorage эсвэл public source code-д оруулахгүй. AdminPlus-ийн одоогийн operational secret auth нь production user identity/session систем биш учраас VPN, SSO, Nginx access control эсвэл LEGACY-X staff role verification-тэй хамт хэрэгжинэ.

## References

[1]: https://github.com/dede177/cs2-admin-plus/blob/main/README.md "Upstream Admin Plus architecture and frontend/backend setup"
