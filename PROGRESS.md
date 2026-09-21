# Admin & Moderation System — progress

Branch: `feature/admin-system` (backend, frontend and plugins repos).

| Phase | Status | Notes |
|---|---|---|
| 1. DB | done | `supabase/legacy_x_admin_system.sql`, validated locally on PGlite. **Not applied anywhere.** |
| 2. Backend | done | `server/legacyX/admin/*`, mounted inside the LEGACY-X router. tsc, 172 tests and the build pass. |
| 3. CS2 plugin | pending | |
| 4. Web panel | pending | |
| 5. Header button | pending | |

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
