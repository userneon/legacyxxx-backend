# Admin & Moderation System — progress

Branch: `feature/admin-system` (backend, frontend and plugins repos).

| Phase | Status | Notes |
|---|---|---|
| 1. DB | done | `supabase/legacy_x_admin_system.sql`, validated locally on PGlite. **Not applied anywhere.** |
| 2. Backend | done | `server/legacyX/admin/*`, mounted inside the LEGACY-X router. tsc, 172 tests and the build pass. |
| 3. CS2 plugin | skipped | Skipped on request ("plugin taliig orhi"). The backend `/game/*` contract is ready for it. |
| 4. Web panel | done | Frontend `feature/admin-system`: `/panel/*` and `/u/:steamId`, lazy-loaded. tsc and vite build pass. |
| 5. Header button | done | ShieldCheck left of the bell (desktop); first sidebar item on mobile. |

## Phase 1 — DB

`supabase/legacy_x_admin_system.sql` (idempotent, one transaction):

- `roles`, `permissions` (with an `owner_only` flag), `role_permissions`, `user_roles`.
- `bans` and `mutes`: SteamID64 only, `issuer_immunity` stored at issue time, `review_status` for the permanent-ban review queue, and `penalty_id` linking to the public `penalties` row.
- `ban_appeals`.
- `reports`, plus the `reporter_accuracy` view (actioned ÷ resolved).
- `player_sessions` with a 30-day `prune_player_sessions()` (scheduled through pg_cron when that extension is present), `player_name_history`, `chat_logs`, `staff_notes`.
- `admin_game_actions`: the queue from the panel to the game servers.
- `admin_audit_logs`: INSERT-only. UPDATE, DELETE and TRUNCATE are revoked and also blocked by triggers, so this holds for the Owner and the service role too.
- `name_filters`, `products`, `announcements`, and `site_config` (append-only versions; a rollback appends a copy).
- `game_servers` gains `api_key_hash`, `api_key_prefix`, `api_key_rotated_at`, `created_by`, `last_seen_at` and `deleted_at`.
- Seeds roles Owner 100 (locked), Manager 80, Admin 50 and Moderator 20 with their permissions, then copies the active `staff` rows into `user_roles` (OWNER→owner, MANAGER→manager, ADMIN→admin).
- The database enforces the Owner lock as well: a locked role cannot lose immunity or permissions, owner-only permissions can only go to a locked role, and the last Owner cannot be removed.

Validation (`node validate.mjs` on PGlite against stubs of users, penalties, game_servers and staff):

- A second run is a no-op.
- The backfill gives the staff OWNER row the owner role, gives MANAGER the manager role, and skips DEVELOPER.
- Each of these is rejected: updating, deleting or truncating the audit log; lowering Owner immunity; removing an Owner permission; granting an owner-only permission to admin; removing the last Owner; a self-report; a permanent ban with an expiry; a SteamID that is not 64-bit; updating site_config.

## Phase 2 — Backend

Module `server/legacyX/admin/`:

- `permissions.ts`: pure rules (`can`, immunity, ban/mute issue, revoke and change, review, roles, game menu). Covered by 21 unit tests.
- `context.ts`:
  - principal loader (roles → permissions, immunity = highest role)
  - `adminRoute(perm)` guard
  - insert-only `writeAudit`
  - stateless re-auth JWT cookie `legacyx_admin_reauth` (10 min)
  - `serverRoute`: game server API key (`x-server-key` or Bearer `lxs_…`), sha256-hashed
- `moderation.ts`: kick, ban, mute, revoke, change, review. Used by both the panel and the game endpoints, so the rules are identical everywhere.
- `game.ts`: `/game/*` for the plugin:
  - heartbeat
  - permissions by SteamID
  - actions (re-checked)
  - panel→server queue
  - sessions connect/disconnect (returns active ban/mute)
  - names
  - chat
  - reports (limits: no self, no staff, one per target per match, 3 per 10 min)
  - in-game announcements
- `panel.ts`:
  - `/users/me` (new: user + `staff` {roles, permissions, immunity} or null)
  - badge, reauth, dashboard, search, live
  - servers: create returns the key once; rotate; delete needs the typed name
  - live, last-N-hours, chat, reports, actions and commands per server
  - public `/players/:steamId`
  - staff-only `/players/:steamId/moderation` plus tabs
  - staff notes
- `moderationRoutes.ts`: kick, bans (issue/change/revoke), review queue, mutes, appeals (staff and the player's own), reports (reporter identity only with `reports.reporter.view`), audit.
- `management.ts`: roles (every change needs re-auth and the typed role name, and logs before/after), products, announcements (plus public `/announcements`), versioned site config with rollback (plus public `/site-config`), name filter.
- `routes.test.ts`: every staff route returns 401 without a user, and every game route returns 401 without a server key. Also checks that uuid `/players/:id` still reaches the existing route, and that re-auth refuses open redirects.

The shared `apiError`/`asyncRoute`/`requireUser`/`userRoute` helpers moved to `server/legacyX/http.ts`, which `routes.ts` now imports. Their behaviour is unchanged. `tsconfig` gained `target: ES2022`, which affects typecheck only; esbuild does the build.

## Phase 3 — CS2 plugin (skipped)

You asked mid-task to leave the plugin out.

- A partial draft of `LegacyX-Staff` (menu engine, API client, main plugin) was moved out of the plugins repo into the session scratchpad. It is not committed.
- The plugins repo is back on `main`, unchanged. Its `feature/admin-system` branch is empty.
- Everything the plugin needs already exists in the backend `/game/*` endpoints.

## Phase 4 — Web panel (frontend repo)

- `src/api/admin.ts`: typed service for every admin endpoint.
- `src/hooks/use-staff.tsx`: `StaffProvider`.
  - Reads `/users/me` and exposes `can(key)`.
  - Polls the badge every 60 seconds.
  - This only controls what is shown; the API re-checks every action.
- `src/panel/*`: its own shell (a separate 87 kB chunk, so players never download it).
  - Sidebar: Dashboard, Live, Players, Moderation (Reports, Bans, Mutes, Appeals, Review queue) and Audit log.
  - "Management" group: Staff & Roles, Servers, Products, Announcements, Website and Name filter.
  - Each item is hidden unless the user has one of its permissions.
- Ctrl+K search covers SteamID, name and match ID.
- `/panel/live` redirects to your current match (from `player_sessions`). If you are not connected, it shows the server list.
- `/panel/servers/:id` has tabs: Live, Last 5 hours (rows link to the profile), Chat log, Reports and Actions.
  - Row flags: prior ban, VAC/game ban, new, many names, first visit.
  - Map change and round restart each have a confirm step.
- `/panel/match/:id`: one column below the xl breakpoint. Checked at 1024px.
- `/u/:steamId`: moderation header, action bar, and the seven tabs (Name history only with `players.name_history.view`).
  - "View as player" shows only what the public `/players/:steamId` returns.
  - "Above your rank" is shown for higher-immunity targets.
  - Players who open `/u/:id` are redirected to `/profile/:id`.
- Risk levels:
  - Kick and mute are one click, sent after 5 seconds unless Undo is pressed.
  - Ban opens a preset modal (reasons and durations).
  - Role changes, server deletion and product deletion require typing the name.
  - Role changes also need a fresh Steam re-auth; the API answers 428 and the page shows a banner.
- `src/api/client.ts` gains `detail` (the backend's reason text, shown only by the panel) and `apiUrl()`. Existing pages are unchanged.

Checked in the browser against a fixture API (not the real backend):

- dashboard
- server page and kick with undo toast
- staff profile and ban modal
- match page at 1024px
- Staff & Roles with the re-auth banner
- header button on desktop and the sidebar item on mobile

## Phase 5 — Header button

- `src/components/staff-panel-button.tsx`: same `glass-strong size-10 rounded-lg` style as the bell, sitting immediately left of it.
  - Tooltip and aria-label: "Staff Panel".
  - Badge: pending reports plus review queue, hidden at 0.
  - Renders nothing until `/users/me` has answered.
- On phones (<768px) the header copy is hidden and "Staff Panel" is the first item in the sidebar menu.

## Decisions

1. **No CLAUDE.md exists** in any of the three repos. I followed the existing code patterns and `MASTER_CONTEXT.md` instead.
2. **The migration is not applied.** The project has no Supabase development branch, and creating one is a paid action that needs your confirmation. The rule says never production, so the migration is validated locally on PGlite and left for you to apply to a dev branch first.
3. **Existing tables are reused, not duplicated.** `game_servers` is extended rather than recreated. `penalties` stays the public record that the Penalties page and profiles read, and new bans and mutes also write a row there. All moderation detail lives in `bans` and `mutes`, which no public endpoint reads.
4. **Products** is an Owner-only catalogue table with CRUD in the panel. There is no purchase flow and no public route. This keeps the earlier Shop/Wallet removal intact.
5. **Reporter identity** needs `reports.reporter.view`, which Owner and Manager have (the spec's hard rule says Owner/Manager). The Owner-only list mentions "see reporter identity", but Manager is the more specific rule and it is the safer choice for review work.
6. **Permission key names:**
   - Manager/Admin share one set; only Manager adds `bans.permanent.revoke`, `bans.review` and `reports.reporter.view`.
   - Moderator gets kick, mute and view reports, plus `panel.access`, `live.view`, `players.view`, `players.moderation.view` and `servers.view` so those screens can be reached.
7. **"Staff" means a user with any role in `user_roles`.** The old `staff` table and the `/staffpanel` page stay untouched for now and should be retired later. DEVELOPER and DESIGNER staff rows are not mapped to a moderation role.
8. **Deleting a user who is the last Owner fails** because of the last-holder trigger. This is intentional.
9. **Re-authentication** uses its own Steam OpenID round trip at `/admin/reauth/steam`, not `/auth/*` (hard rule). It results in a 10-minute signed cookie bound to the user id. The old `staff_sessions` flow only admits OWNER/MANAGER `staff` rows and its cookie path (`/api/v1/staff`) does not cover `/staffpanel`, so reusing it would not be reliable.
10. **`/users/me` is new.** `/auth/me` is untouched. The frontend reads staff status from `/users/me`.
11. **Kick from the web panel is queued** in `admin_game_actions`, and the plugin polls `/game/queue`. In-game actions are executed by the plugin once the backend answers `ok`.
12. **Permanent bans from an actor without `bans.review`** (so Admin) are `review_status = pending`. Rejecting one in review lifts the ban and must pass the revoke rules.
13. **Changing a ban's length counts from the original issue time.** Shortening to a length that has already passed is refused; revoke instead.
14. **"New account"** means first seen on LEGACY-X servers less than 7 days ago. "Many name changes" means 3 or more names in 30 days. VAC/game bans come from Steam `GetPlayerBans` (`STEAM_WEB_API_KEY`), cached for 6 hours, and are skipped if the key is missing.
15. **Report without a match id:** "once per match" falls back to "once per target per server per 2 hours".
16. **Server deletion is a soft delete** (`deleted_at`, key cleared), so historical sessions and chat keep their server.
17. **Role assignment** cannot grant a role at or above the actor's immunity, so a second Owner cannot be created from the panel. This is the safe reading of "nobody can act on equal or higher".
18. **The fetch client is kept instead of axios.** It already sends `credentials: "include"` (httpOnly cookies) and the Bearer token. Adding axios would duplicate it.
19. **The panel is a separate shell** at `/panel/*` and `/u/*`, rendered outside the site sidebar, so it can have its own navigation and work at ≤1024px. The Vite port is unchanged (5173).
20. **Undo** delays the request by 5 seconds rather than sending it and reverting afterwards, so an undone kick never reaches the server. The timer is not tied to the page, so leaving the page does not cancel an action you chose.
21. **Website config** is edited as versioned JSON. No site page reads `/site-config` yet; wiring it up is follow-up work.

## Not done / follow-ups

- **Apply the migration to a Supabase dev branch first.** It is validated on PGlite only. Creating a branch is a paid action, so it needs your OK. Then deploy the backend and frontend.
- **CS2 plugin** (skipped). The draft is in the scratchpad if you want it later.
- **Web announcements are stored and served** at `/announcements`, but no site banner reads them yet. The same applies to `/site-config`.
- **Retire the old `/staffpanel` and `staff` table** once the new panel is live. Its cookie path `/api/v1/staff` does not match `/staffpanel` routes.
- **Register servers in the panel after deploy** to get API keys.
