# Admin & Moderation System — progress

Branch: `feature/admin-system` (backend, frontend and plugins repos).

| Phase | Status | Notes |
|---|---|---|
| 1. DB | done | `supabase/legacy_x_admin_system.sql`, validated locally on PGlite. **Not applied anywhere.** |
| 2. Backend | pending | |
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
