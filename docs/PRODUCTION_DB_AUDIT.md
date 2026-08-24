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
