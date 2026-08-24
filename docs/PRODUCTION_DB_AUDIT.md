# LEGACY-X Production Database Audit

**Project:** `Legacy-x` (`htfkfkykvrxyrprrlkwq`), Supabase `ap-southeast-2`.

The production project already contains the initial LEGACY-X schema and migration history through `legacy_x_feedback_weekly_cooldown`. Existing feature tables are therefore not recreated or modified by the Skinchanger rollout. The Skinchanger migration adds only the isolated `legacy_x.skinchanger_*` tables, functions, indexes, and service-role grants it owns.

> The current database advisory reports that 24 existing legacy tables have RLS disabled. This rollout deliberately does **not** enable RLS for those existing tables: enabling RLS without their feature-specific policies could interrupt live API behavior. The Skinchanger migration enables RLS on its own new tables, revokes `anon` and `authenticated` access, and grants access only to `service_role` through the Root API.

The production data path is **Frontend → Root API → Supabase**. Image assets remain direct static/CDN URLs; only catalog metadata and image keys pass through the API. The game plugin path remains **SkinBridge → Root API → Supabase**, never direct database access.

## Applied Scope

1. Apply `supabase/legacy_x_skinchanger.sql` with the Supabase migration API.
2. Do not run catalog ingestion until the protected storage/CDN destination and a designated operator environment are configured.
3. Do not issue the `legacyx-skinbridge` plugin token or install a game server until a CounterStrikeSharp server is available.
4. Run backend contract tests and Root API environment checks before publishing the corresponding Git commits.

## Real Catalog Restoration

The real catalog source is the public ByMykel CS:GO API: `https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en`. A no-write coverage run resolved **33,221** normalized items: 34 firearms, 16,917 weapon skins, 4,042 knife rows, 470 glove rows, 63 agents, 189 music kits, 294 pins, 11,134 stickers, and 78 charms.

For the first production restoration, catalog `image_key` values may be the source's direct HTTPS static image URL. The Root API returns that URL unchanged, so image bytes do not pass through the API. A future controlled media operation may replace each external source URL with content-hashed `STATIC_ASSET_BASE_URL` WebP files without changing catalog IDs or player loadouts.

The Supabase MCP request payload limit required the initial 33,221-record upsert to run as idempotent 4,000-record transactions. All nine batches were applied successfully during the 2026-08-24 production restoration. The final `category,count(*)` validation exactly matched the no-write coverage counts.

## Live Validation Snapshot — 2026-08-24

`https://api.legacyx.cc/api/v1/skinchanger/catalog?category=weapon&limit=3` is deployed and correctly returns **401** for a request without an authenticated session. Its CORS preflight from `https://legacyx.cc` returns **204** with that exact allowed origin, credentials enabled, and `GET, POST, PUT, PATCH, DELETE, OPTIONS` allowed.

A representative database image URL resolved directly from `community.akamai.steamstatic.com` with HTTP **200**, `image/png`, and no Root API image-byte proxy. The live browser page renders the authenticated empty state when no Steam session is present; catalog browsing and loadout mutation must therefore be validated from a trusted player Steam session.

The API-only SkinBridge fork built successfully in .NET 8 Release with zero warnings/errors and has no direct Supabase, Npgsql, connection-string, or `SUPABASE_*` reference in its C# source. No game server or plugin token was created during this rollout.

## Reviews and Loadout Audit — 2026-08-24

| Surface | Evidence | Finding | Required correction |
| --- | --- | --- | --- |
| `legacy_x.feedback` | Production table has eight live rows; existing advisory flags legacy RLS disabled | Existing feedback data is live and must not be dropped. Public review listing and authenticated submit require an explicit, versioned access contract. | Add a dedicated policy migration only after API/RPC regression tests; do not enable RLS without policies. |
| Feedback API | Legacy response variants include an array and `{ feedback: ... }` envelopes | Frontend list/submit handling can break when the deployed route shape differs. | Normalize temporary response forms client-side, then converge the Root API on one canonical response. |
| Loadout persistence | Latest persisted row has version 29, weapon `weapon:7`, team `t`, and active AK-47 Asiimov options | The database write is durable. Refresh disappearance is a GET-response, frontend hydration, or stale deployment issue, not a missing write. | Snapshot-test `GET /skinchanger/loadout` and frontend hydration; deploy matching frontend/backend commits as a pair. |
| Loadout RPC | `save_skinchanger_loadout` deletes and reinserts entries for one `p_user_id` | Root API user isolation is present, but simultaneous saves can overwrite one another and SQL does not independently whitelist slot/model/team combinations. | Add expected-version concurrency and server-side slot/model/team validation in a new additive migration; retain a compatibility wrapper and rollback migration. |
| Skinchanger objects | 33,221 catalog rows, one loadout, one loadout entry; active user foreign keys | No Skinchanger table, function, index, or schema can be classified as obsolete from current evidence. | Do not drop production objects in this rollout. |
| Security-definer RPCs | Save, feedback submit, queue/claim, and ack functions are security definer | Caller identity, `search_path`, and EXECUTE grants need a dedicated hardening review. | Keep browser access behind the Root API; audit function bodies and grants before direct client or RLS policy changes. |

> Source records: read-only production Supabase schema, table, function, and advisor checks performed on 2026-08-24. No legacy table, schema, function, index, or production user data was deleted during this audit.

### Read-only confirmation after the audit snapshot

The live public `GET https://api.legacyx.cc/api/v1/feedback` response is the canonical array consumed by the current frontend and contains the eight persisted reviews with mapped Steam identities. The reported submit error is consistent with the `submit_feedback_weekly` rule: the player already submitted on 2026-08-22 and the RPC enforces one review per seven days. The UI previously reduced this controlled `429` response to a generic failure instead of showing the next eligible time.

Production function introspection confirmed that the deployed `save_skinchanger_loadout(uuid,jsonb)` still performs a user-wide `DELETE` followed by an insert and lacks an expected-version argument. A later read-only loadout query proved the reported player's data persisted at version 43 with independent `knife` and `glove` rows, including catalog relations and custom options. Therefore database durability is not the refresh failure; response hydration/deployment pairing and the whole-snapshot mutation model remain the corrective targets.

The additive migration `legacy_x_skinchanger_entry_mutations` was applied successfully after this audit. It creates service-role-only `upsert_skinchanger_loadout_entry` and `delete_skinchanger_loadout_entry` functions, each requiring the authenticated Root API user's expected loadout version. Existing tables, rows, indexes, catalog IDs, and legacy `save_skinchanger_loadout` compatibility behavior were retained. The repository includes a rollback SQL artifact that drops only these two new functions after the matching API commit has first been reverted.

The database advisory also reports RLS disabled on 24 older `legacy_x` tables, including `feedback`. This is a critical security finding, but it is not evidence that any table is obsolete. Enabling RLS without feature-specific policies could immediately break the live Root API, so no bulk RLS enablement or table deletion is included in this rollout. See [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).
