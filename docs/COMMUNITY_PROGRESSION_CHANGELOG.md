# LEGACY-X EXP, Level & Clan System Changelog

## Delivered

The previous rank-only pipeline now grants community progression from the same trusted MatchZy final-map event. No browser UI, static frontend bundle or client-held service credential was added. `legacyxxx-backend` owns state; `legacyxxx-plugins` owns server runtime UX.

| Capability | LEGACY-X implementation |
|---|---|
| EXP | Completed exact-5v5 maps earn bounded match XP based on outcome and individual performance. |
| Level | Backend calculates a deterministic level from total XP and synchronizes the existing user level field. |
| Clan score | Active clan membership at result processing receives the member XP plus a win bonus. |
| Idempotency | Community receipt and per-player event uniqueness prevent a retried MatchZy result from duplicating XP or clan points. |
| Player commands | `css_xp`, `css_level`, `css_progress`, `css_clan` use a Community plugin profile lookup. |
| Secret isolation | Game servers hold only the plugin secret. Operator API and Supabase service-role secrets never enter CounterStrikeSharp config. |

## Plugin stack boundary

MatchZy remains the only match lifecycle owner. AdminPlus remains the frontendless RCON/staff API and server-event ingress. AFK Manager remains the MatchZy-aware inactivity policy. The new Community plugin has no writable game-state command and does not register map change, ready, AFK or match-end handlers.

## Validation

Root backend TypeScript/build, AdminPlus syntax/rank contract test, Community plugin, MatchZy and AdminPlus plugin builds completed successfully. Both root and AdminPlus production dependency audits reported no known vulnerabilities. A runtime smoke test confirmed unauthenticated plugin requests receive HTTP 401, while the `legacyx-community` plugin ID with the plugin secret passes authentication and reaches the protected database read layer.

## Production prerequisites

1. Apply `legacy_x_adminplus.sql`, `legacy_x_rank.sql`, then `legacy_x_progression_clans.sql` to the intended Supabase project.
2. Deploy the matching MatchZy, AdminPlus, AFK Manager and `LegacyXCommunity.dll` artifacts.
3. Copy the two private config examples to the CS2 server and insert the production HTTPS URL plus unique plugin secret.
4. Finish one real exact-5v5 map and verify one rank receipt, one community receipt, ten XP rows and the affected clan score update.
5. Keep clan create/join/leave in the existing backend moderation workflow until staff has an explicit clan governance policy.
