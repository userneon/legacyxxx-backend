# LEGACY-X Frontend → AdminPlus холболт

AdminPlus dashboard нь одоогоор тусдаа React/Vite application хэлбэрээр байрлана. Энэ сонголт нь LEGACY-X-ийн үндсэн public frontend-ийг RCON control surface-ээс тусгаарлаж, admin panel-ийн dependency болон release cycle-ийг бие даалгана.

## Recommended production topology

Production-д `adminplus.legacyx.cc` эсвэл `admin.legacyx.cc` нь AdminPlus backend-ийн HTTPS endpoint байна. Frontend build нь backend-ийн `frontend/dist` folder дотор орж, Express нэг process-оос UI болон `/api/*` route-ийг хамт serve хийж чадна. Энэ same-origin хувилбар нь browser талд CORS болон API secret дамжуулах эрсдэлийг хамгийн бага байлгана.

```text
Staff browser
   │ https://admin.legacyx.cc
   ▼
Nginx TLS termination
   │ http://127.0.0.1:3001
   ▼
AdminPlus Express + built React UI
   │ x-api-secret
   ▼
CS2 RCON / CounterStrikeSharp plugin
```

## Build-time API base

`adminplus/frontend/src/api/rcon.js` нь `VITE_ADMINPLUS_API_BASE` variable-ийг дэмждэг.

Same-origin production build-д variable өгөх шаардлагагүй; default нь `/api` байна.

```bash
cd /srv/legacyxxx
pnpm adminplus:build
```

Хэрэв UI-г тусдаа static host дээр байршуулж, API-г `https://admin-api.legacyx.cc` дээр ажиллуулах бол build хийхийн өмнө:

```bash
VITE_ADMINPLUS_API_BASE=https://admin-api.legacyx.cc/api \
  npm --prefix adminplus/frontend run build
```

Тэр тохиолдолд backend-ийн `FRONTEND_URL=https://admin.legacyx.cc`, Nginx-ийн CORS origin болон HTTPS certificate гурвын утга яг таарах ёстой. `FRONTEND_URL=*` production-д ашиглахгүй.

## Local development

Нэг terminal дээр backend:

```bash
cd /srv/legacyxxx
npm --prefix adminplus/backend install
npm --prefix adminplus/backend run dev
```

Нөгөө terminal дээр frontend:

```bash
cd /srv/legacyxxx/adminplus/frontend
ADMINPLUS_BACKEND_ORIGIN=http://127.0.0.1:3001 npm run dev
```

Vite proxy нь `/api` болон `/health` хүсэлтийг `ADMINPLUS_BACKEND_ORIGIN` руу дамжуулна. Browser-ийн Login хэсэгт `API_SECRET`-ийг зөвхөн local testing эсвэл trusted staff workstation дээр оруулна.

## Authentication behavior

Frontend нь secret-ийг `localStorage` дахь `api_secret` key-д хадгалж, API request бүрт `x-api-secret` header нэмдэг. Энэ нь production-grade user identity/session биш учраас dashboard domain-ийг public community member-д нээхгүй; зөвхөн staff-only access control, VPN, SSO эсвэл Nginx basic access layer-ийн аль нэгийг давхар хэрэглэнэ.

Нууц утга алдагдсан тохиолдолд `API_SECRET`-ийг VPS дээр солиод PM2 process-ийг `--update-env`-ээр restart хийнэ. Browser-ийн localStorage дахь хуучин secret-ийг админ төхөөрөмжүүдээс цэвэрлэнэ.

## API contract

| Frontend operation | API endpoint | Plugin/RCON behavior |
|---|---|---|
| Player list | `GET /api/players` | `sm_playerinfo_all`, fallback `status` |
| Respawn/freeze/god/slap/kick | `POST /api/players/...` | Player userid validation хийсний дараа `sm_*` command |
| Team, HP, money, weapon | `POST /api/players/...` | Allowlist болон numeric range шалгана |
| Maps | `GET /api/server/maps` | Official, configured, mounted болон RCON map list нэгтгэнэ |
| Change map | `POST /api/server/changelevel` | Safe map name эсвэл workshop ID |
| Raw command | `POST /api/rcon` | Production-д default HTTP 403; break-glass үед л enable |

## Integration with the existing LEGACY-X public frontend

Existing LEGACY-X public UI рүү AdminPlus-ийг embed хийхийг зөвлөхгүй. Харин staff-only холбоосыг үндсэн navigation-д conditional байдлаар харуулж, `https://admin.legacyx.cc` руу шинэ tab-аар нээнэ. Ингэснээр public frontend-ийн session cookie, Supabase service-role key болон RCON secret хоорондоо холилдохгүй.

Хэрэв нэг React application дотор route хэрэгтэй бол AdminPlus-ийн API client-ийг `client/src` рүү хуулж оруулахын оронд reverse proxy-оор `/admin-api` prefix үүсгээд, staff role check-ийг LEGACY-X server дээр хийж байж route-г нээнэ. Service-role key-г client bundle руу хэзээ ч оруулахгүй.

## References

[1]: https://github.com/dede177/cs2-admin-plus/blob/main/README.md "Upstream Admin Plus architecture and frontend/backend setup"
