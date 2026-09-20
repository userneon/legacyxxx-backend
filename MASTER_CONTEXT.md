# MASTER_CONTEXT — LEGACY-X

> Энэ файл нь төслийн санах ой. Код, бүтцийг давхардуулж бичихгүй — зөвхөн контекст, шийдвэр, түүх, дараагийн алхам.
> Мэдэхгүй зүйлийг `UNKNOWN` гэж тэмдэглэнэ. Таамаглаж бичихгүй.
> Сүүлд шинэчилсэн: 2026-09-20

---

## 1. Төслийн контекст

- LEGACY-X — Counter-Strike 2 community platform (Монгол). Тоглогчид Steam-ээр нэвтэрч, сервер/match-д нэгдэж, rank, статистик, penalty, wallet, shop-оо хардаг.
- Хоёр repo: `userneon/legacyxxx-frontend` (React + Vite + Tailwind v4 + shadcn/ui), `userneon/legacyxxx-backend` (Express 5 API + Supabase, дотроо AdminPlus сервис).
- Өгөгдөл Supabase дээр, `legacy_x` schema. Game server-үүд plugin-ээр (MatchZy/RCON) backend рүү event илгээдэг.
- Production API: `https://api.legacyx.cc`, pm2-оор ажиллана.

## 2. Одоогийн төлөв

- **Салаа зөрүү**: production backend `feature/legacyx-skinchanger-live` дээр ажиллаж байна, frontend `main` дээр. Frontend feature flag-ууд бүгд `false`.
- Ажлын хуулбарууд (түр хавтас, push хийгээгүй):
  - frontend: `C:\Users\jjmyn\AppData\Local\Temp\lx\legacyxxx-frontend` (branch `main`)
  - backend worktree: `C:\Users\jjmyn\AppData\Local\Temp\lx\be-live` (branch `fix/public-read-routes`)
- **Юу ч commit/push хийгээгүй.** Бүх өөрчлөлт дээрх хоёр хавтаст л байна.
- Preview: `vite.preview.local.config.ts` (git-ээс хасагдсан) mock өгөгдөлтэй, `localhost:5173`. Login mock: `/__preview-login`.
- Тест: backend `npx vitest run` → 41 pass (`JWT_SECRET` env хэрэгтэй), AdminPlus contract test pass. Frontend `tsc -b` + `vite build` pass.
- **Production өгөгдөл хоосон**: `legacy_x.matches`, `legacy_x.game_servers`, `legacy_x.reconnect_servers` гурвуулаа 0 мөр. Тиймээс /play одоогоор хоосон харагдана.

## 3. Гол шийдвэрүүд

- **Дүрэм**: frontend эсвэл backend-д өөрчлөлт хийвэл заавал FE↔BE холбоосыг шалгана (route, auth, өгөгдлийн бүтэц, CORS).
- Зөвхөн бодит API өгөгдөл харуулна. Байхгүй талбарыг зохиож харуулахгүй (rank, ADR, ping, spectator г.м.).
- Зураг бүгд bundled asset (`src/assets/...`), `/manus-storage/*` гэсэн зам production дээр хэзээ ч байгаагүй.
- Бүх animation `prefers-reduced-motion`-г хүндэтгэнэ, нуугдсан tab дээр `requestAnimationFrame` зогсдог тул `document.visibilityState` шалгана.
- Tailwind v4: viewport breakpoint-оос илүү container query (`@container`) ашиглана.
- FACEIT байхгүй тоглогчид: ижил дизайнтай "Not connected" box үлдэнэ, харин link/connect UI байхгүй.
- Guest хэрэглэгч үзэх хуудсуудад public read route нэмсэн.
- **Feature switch (`frontend/src/lib/features.ts`)**: эхний хувилбарт ажиллахгүй feature-үүдийг UI-аас 100% нуух. `shop`, `wallet`, `clan`, `roster` = OFF. Унтарсан feature-ийн nav, товч, card, route огт render хийгдэхгүй — placeholder, "Coming Soon" байхгүй. Код нь repo-д үлдэнэ, дахин асаахад `FEATURES` дотор нэг мөр `true` болгоход хангалттай.
- **/play (roster асаалттай үеийн загвар)**: тусдаа "Live servers" hero section байхгүй. Live server-үүд ердийн card-ны grid дотор, ижил дизайнаар харагдана. Card бүр дээрээс roster харна. Хуучин roster dialog дизайн (map palette, team art, map badge) устгасан — оронд нь энгийн хавтгай дизайн.

## 4. Түүх (гол үйл явдлууд)

- Production 500/502 алдаа: `public` schema устсанаас PostgREST schema cache ачаалж чадаагүй → хэрэглэгч SQL-ээ ажиллуулж, pm2 restart хийж засав.
- Steam background/avatar-г scraping-ийн оронд албан ёсны Steam API-аар авдаг болгов.
- Match details (roster, statistics, rounds) end-to-end нэмэв: DB migration файл, AdminPlus ingestion, API endpoint, frontend dialog.
- FE↔BE зөрүү олж зассан: `PenaltyType` `mute` → `comm`, `totalMutes` → `totalComms`, permanent/lifted эрэмбэ, `/community/leaders` route байхгүй (ашиглагдаагүй).
- MatchZy `round_end.winner.team` нь тухайн раундын ялагч биш, map-ийн тэргүүлэгч — score зөрүүгээр тооцдог болгов.
- UX ажлууд: dropdown open/close animation, checkbox, review од, profile шинэчлэл (дэлгэц дүүргэх), play card animation, удаан зөөлөн hover, map/rank зураг, FACEIT level icon (fill animation), хүн уншихад ойлгомжтой цаг (review/penalty/wallet), penalties хуудас шинэчлэл.
- 2026-09-20: /play дээр эхлээд тусдаа Live servers section хийсэн, дараа нь хэрэглэгчийн шаардлагаар устгаж, roster-ийг ердийн card руу шилжүүлэв.

## 5. Дараагийн ажлууд

1. Commit/push зөвшөөрөл авах. Дараалал: backend PR → `feature/legacyx-skinchanger-live`, backend deploy, дараа нь frontend.
2. `supabase/legacy_x_match_rounds.sql` migration-г Supabase дээр ажиллуулах (хараахан ажиллаагүй).
3. Backend lockfile-ууд `package.json`-той таарахгүй (`npm ci` унана, `sharp` дутуу) — засах.
4. Frontend feature flag-уудыг нуусан commit `1a49981`-ийг яах вэ гэдгийг шийдэх.
5. Нээлттэй TODO: plugin `api_tokens`, хоосон `staff` хүснэгт, season rollover ажиллахгүй байгаа, MGE rank зураг дутуу, wallet дээрх `RelativeTime` шалгаагүй.
6. Production өгөгдөл хоосон тул /play-ийн бодит байдлыг зөвхөн plugin heartbeat ирж эхэлсний дараа шалгаж болно.

## 6. Ажиллах дүрэм

- Хэрэглэгчтэй **монголоор** ярина, техник нэр томьёог англиар нь үлдээнэ.
- Өөрчлөлт хийсний дараа FE↔BE холбоосын шалгалтыг тайлагнана.
- Commit/push/deploy зөвхөн хэрэглэгч зөвшөөрсний дараа.
- Тест ажиллуулж, үр дүнг үнэн зөвөөр хэлнэ (унасан бол унасан гэж хэлнэ).
- Файл засахдаа EOL (CRLF/LF) хадгална; олон мөрийн засварт Node script ашиглаж, яг нэг л тааралт байгааг шалгана.

## 7. Session handoff

- Хамгийн сүүлд хийсэн: /play дээрх тусдаа Live servers section-ийг устгаж, live server-үүдийг ердийн grid-д card болгон нэгтгэв; roster-ийг ердийн card дээрээс нээдэг болгов; roster dialog-ийг энгийн шинэ дизайнаар бүрэн дахин бичив (нүүр хуудасны хэрэглээ хэвээр ажиллана).
- Backend талд `mapMatch` одоо `connectAddress`-ийг `game_servers(ip_address, port)`-оос гаргадаг болов (өмнө нь буцаадаггүй байсан тул Join болон Roster товч production дээр ажиллахгүй байсан).
- Roster dialog дээр map icon (`src/assets/map-icons/de_*.png`, 10 map) болон T/CT logo (`src/assets/sides/{t,ct}.svg`) ашиглав — хэрэглэгч файлуудыг өөрөө өгсөн. Icon байхгүй map-д зурсан neutral fallback үлдсэн.
- Browser дээр шалгасан: desktop болон mobile (375px) дээр card, roster dialog, хоосон төлөв бүгд зөв.
- 2026-09-20: Shop, Wallet, Clan, Roster-ийг `features.ts`-ээр бүрэн OFF болгов. Sidebar, header Wallet товч, /shop /wallet /clan /clans route, explore дэх Clans tab, profile дэх clan chip/card, home дэх "Active Clans" tile, play дэх Roster товч болон live server card бүгд харагдахгүй. Skinchanger хэвээр ON — хэрэв үүнийг ч хаах бол `FEATURES.skinchanger = false`.
- 2026-09-20: Skinchanger-ийг local preview дээр ажиллуулахын тулд `vite.preview.skinchanger.ts` (git-ignored) нэмэв — catalog, loadout, active-server, status, apply бүгдийг mock-оор өгнө, item зургийг өөрөө SVG-ээр үүсгэдэг тул интернэт шаардахгүй. Skinchanger UX шинэчлэл: page header (loadout төлөв + server + Apply to server), "Your loadout" самбар, card-ны мэдээллийн шатлал + equipped badge, wear tier (FN/MW/FT/WW/BS) сонголт, StatTrak toggle, name tag. `/skinchanger/apply`, `/status`, `/active-server` route-ууд backend дээр аль хэдийн байсан ч UI-д огт ашиглагдахгүй байсан.
- Баталгаажаагүй/мэдэхгүй: production дээр ямар plugin server бодитоор heartbeat илгээдэг нь `UNKNOWN` (хүснэгт хоосон).
