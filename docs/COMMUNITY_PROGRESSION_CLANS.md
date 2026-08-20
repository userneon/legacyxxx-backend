# LEGACY-X Community Progression & Clan Integration

## Ownership

The CS2 server does not calculate competitive data. MatchZy is the **only** match lifecycle owner; it emits one signed final `map_result` for each completed 5v5 map. AdminPlus API validates the signed event and calls the rank and community RPCs. Supabase is the only source of truth for rating, EXP, level, clan membership and season score.

```text
MatchZy final map_result
  → AdminPlus plugin-authenticated endpoint
  → ingest_rank_map_result
  → ingest_community_map_result
  → rank, XP/level and clan season tables
  → LEGACY-X Community plugin profile commands
```

## Progression policy

Only validated completed MatchZy 5v5 map results earn XP. A player earns a bounded map reward of **100 base XP**, plus **50 XP for a win**, up to **120 kill XP**, up to **50 assist XP**, and up to **30 headshot XP**. The 350 XP upper limit prevents a single extraordinary map from creating an excessive gap and avoids idle-time or round-by-round farming.

Level is calculated from total XP using `floor(sqrt(experience / 150)) + 1`, with a minimum Level 1. A completed map is idempotent by MatchZy `event_id`; retrying the same remote event cannot grant XP, rank or clan score twice.

Clan season points equal a member's map XP plus a 50-point win bonus. Membership is resolved at the time the result is processed; a player cannot earn points for two clans from one result because the LEGACY-X membership safety RPC permits one membership at a time.

## Database order

Apply migrations in this order:

```text
legacy_x_adminplus.sql
legacy_x_rank.sql
legacy_x_progression_clans.sql
```

The third migration relies on the existing `users`, `player_stats`, `clans`, `clan_members`, `rank_seasons`, `rank_player_seasons` and AdminPlus audit tables. It introduces `community_*` tables/views and the `ingest_community_map_result` RPC.

## API endpoints

Every endpoint below is **staff API-secret protected** except the plugin profile endpoint, which uses the independent plugin secret.

| Endpoint | Use |
|---|---|
| `GET /api/community/experience?limit=100` | EXP and level leaderboard. |
| `GET /api/community/clans?season=season-1&limit=100` | Clan season leaderboard. |
| `GET /api/community/players/:steamId` | Staff profile with XP/level/rank/clan data. |
| `GET /api/plugin/matchzy/community/players/:steamId` | CS2 Community plugin lookup; plugin secret only. |

## Server configuration

The MatchZy rank private config must already point at `POST /api/plugin/matchzy/events`. Deploy `LegacyXCommunity.dll`, then copy `community/config/LegacyXCommunity.json.example` to the live CounterStrikeSharp config directory and set the same **plugin secret** plus the production HTTPS API URL. Never place `API_SECRET` or Supabase service keys on the game server.

## Clan governance

Clan create/join/leave ownership remains in the existing LEGACY-X backend clan workflow. The CS2 plugin intentionally does not offer open chat creation, tag changes or membership transfer; those actions need validation, moderation and audit evidence. The in-game `css_clan` command is read-only and shows the current server-verified membership.
