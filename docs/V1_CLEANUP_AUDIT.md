# V1 cleanup audit (2026-09-24)

Scope: one ranking source of truth, removal of Clans / seasonal rank / community levels / Shop-Wallet-Promo
leftovers / Manus-era dead code, across `legacyxxx-backend`, `legacyxxx-frontend`, `legacyxxx-plugins` and the
production Supabase schema `legacy_x` (read-only inspection; the migration was dry-run inside a rolled-back
transaction, not applied).

## Database objects removed by `supabase/legacy_x_v1_cleanup.sql`

| Object | Rows | Live references before this change | Action |
|---|---:|---|---|
| `rank_seasons`, `rank_player_seasons`, `rank_match_results`, `rank_season_archives`, `rank_season_rollovers`, view `rank_leaderboard`, fns `ingest_rank_map_result`, `rollover_monthly_rank_season`, `active_rank_season` | 1 / 0 | `/public/rank/leaderboard`, profile matches and match details (API); AdminPlus rank/season modules; `core_matches.season_id` FK; `ingest_core_match_event` required an active season; view `core_match_history` | API + AdminPlus code removed/replaced; function rewritten without seasons; view recreated; column dropped; objects dropped |
| `community_player_progression`, `community_match_experience`, `community_event_receipts`, views `community_*`, fns `ingest_community_map_result`, `community_level_from_experience` | 0 | `/plugin/community/players/:steamId` (Community plugin `!profile`), AdminPlus community module | Route now reads the competitive ladder; plugin updated; objects dropped |
| `clans`, `clan_members`, `clan_season_scores`, enum `clan_role`, fns `create_clan_with_leader`, `delete_owned_clan`, `join_clan`; `staff_team` | 0 | `/clans*`, `/search/clans`, `/servers/home-stats`, `/public/overview` (clan count); frontend clan page (feature-flagged off) | Routes, flag and frontend removed; objects dropped |
| `matches`, `match_favorites`, `player_match_history`, enums `match_status`, `play_mode`, `match_result`, fn `ingest_player_match_result` | 0 | `/play/matches*`, `/plugin/matches*`, `/plugin/player-match-history`; no plugin calls them | Play page now reads live reconnect heartbeats; routes removed; objects dropped |
| enums `payment_method`, `shop_rarity`, `wallet_tx_type` | — | none (tables were dropped on 2026-09-20) | dropped |

Added: `users.notification_prefs jsonb` (Settings → Notifications). Changed: `users_hidden_profile_sections_known` also
accepts `loadout` (Profile → "What others can see" → Loadout).

Kept on purpose: `player_stats` (played hours in the ladder, profile stats), `match_rounds` (round timeline; no
writer yet), `game_servers` (staff panel, tournament matches), `community_partners/creators` (community content),
`user_sessions` (auth), all Match Core, reconnect, skinchanger, penalties, feedback, notifications, staff and
phantom tables.

## Bug found by the dry run

`ingest_core_match_event` inserted the `match_created` event row before the match row. `core_match_events.match_id`
references `core_matches` and is not deferrable, so **every `match_created` event failed** (which is why
`core_matches` holds 0 rows). The cleanup migration creates the match first.

## Backend dead code removed

- 28 duplicate route registrations in `routes.ts` that Express could never reach (the first registration wins).
- Unused Manus-era "frontend contract" routes: `/servers*`, `/leaderboard`, `/players/*`, `/matches*`,
  `/penalties`, `/penalties/stats`, old `/tournaments/{info,matches,bracket,register}` (clan-based).
- AdminPlus: `rank.js`, `seasons.js`, `community.js`, their routes, the MatchZy `map_result` rank ingestion and
  the monthly season scheduler; shared Supabase helpers moved to `supabase.js`.
- A stray `@@` diff marker in `adminplus/backend/.env.example`.

## Deploy order

1. Deploy the API (and AdminPlus) from this change.
2. Run `supabase/legacy_x_v1_cleanup.sql` once.
3. Deploy the frontend.
4. Update the plugins (Match Core `competitive_result` v2, Community `!profile`, heartbeat capacity).
