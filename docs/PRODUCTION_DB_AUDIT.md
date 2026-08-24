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
