# LEGACY-X Production Skinchanger Operator Runbook

## Architecture boundary

The only supported data paths are:

```text
Website → Root API → Supabase
CS2 LegacyXSkinBridge → Root API → Supabase
```

The website, browser, and game plugin must never contain a Supabase URL, service-role key, SQL driver, or direct database configuration.

## Required production configuration

| Component | Required values |
|---|---|
| Root API | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY` |
| SkinBridge plugin | `ApiBaseUrl`, `PluginId=legacyx-skinbridge`, `PluginSecret`, `ServerId`, `ApiPollSeconds` |
| API token | A hashed `api_tokens` record for `legacyx-skinbridge` with `skinchanger:read` and `skinchanger:write` scopes only |

Copy `weaponpaints-legacyx/config.example.json` to the CounterStrikeSharp plugin configuration directory on the staging server, then replace only the placeholder `PluginSecret`. Do not commit the copied runtime configuration, and do not reuse a token across servers.

## Catalog ingest

Run the migration first, then use the operator-only script from the backend directory:

```bash
node scripts/ingest-skinchanger-catalog.mjs --category=weapon_skin --limit=100
node scripts/ingest-skinchanger-catalog.mjs --category=knife --limit=100
node scripts/ingest-skinchanger-catalog.mjs --category=sticker --limit=100
node scripts/ingest-skinchanger-catalog.mjs --category=charm --limit=100
```

The script downloads catalog metadata, converts downloaded item artwork to WebP with `sharp`, uploads it to API-owned storage, and upserts only metadata plus the resulting storage key. Start with a bounded category/limit in staging. Review the item count and failed-image warnings before a full ingest.

## CS2 staging flow

1. Apply `supabase/legacy_x_skinchanger.sql` in the production/staging database.
2. Build `weaponpaints-legacyx` and install the compiled DLL plus upstream required gamedata/data files on a dedicated CounterStrikeSharp staging server.
3. Configure the plugin with its server-scoped token; do not enable in-game menus or chat mutation commands.
4. Confirm connect, heartbeat, and disconnect session events reach the Root API.
5. Save a loadout through `/skinchanger`, queue an apply job, and observe `queued → leased → applied` in the API audit trail.
6. For one weapon, verify the permitted skin wear range, one sticker in each selected slot, and one charm. Confirm the queued payload contains only catalog-resolved item IDs and that the player receives the look on the next safe weapon give/spawn.
7. Test duplicate sticker slots, inactive or mismatched accessory catalog IDs, non-weapon accessory requests, disconnect, stale session, lease expiry, duplicate acknowledgement, invalid token, and plugin restart before production rollout.

## Rollback

1. Disable the `legacyx-skinbridge` API token.
2. Remove or disable the SkinBridge plugin from the affected game server.
3. Keep catalog/loadout/job data for audit; cancel queued jobs rather than deleting audit records.

## Licensing and policy

This fork incorporates GPLv3 WeaponPaints code. Preserve `LICENSE`, `UPSTREAM.md`, and all required notices, and provide corresponding source when distributing the modified plugin. Valve’s server guidelines may restrict use of unowned cosmetics; obtain product/legal approval before a public rollout.
