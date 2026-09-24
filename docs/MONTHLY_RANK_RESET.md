# LEGACY-X Monthly Rank Reset

## Behavior

At the first successful scheduler check in a new **UTC month**, LEGACY-X closes the active competitive season, archives up to 500 leaderboard and clan leaderboard entries, opens one new season, and starts rating/clan season scoring from a clean state. Player **XP and level are retained** because they represent long-term community progress rather than a monthly competitive position.

| Data | Monthly behavior |
|---|---|
| Competitive rating | Reset by opening a new empty season; new players begin at the existing 1000 rating baseline. |
| Rank leaderboard | Previous season is archived; current leaderboard becomes empty until completed 5v5 maps arrive. |
| Clan season score | Reset by opening a new season; archived with the previous season leaderboard. |
| XP and level | Retained permanently. |
| Match history | Retained under the completed season. |

## Execution model

The existing API-only backend process performs a deterministic database check immediately after boot and then every hour. The reset does not depend on the exact midnight process being alive. The SQL function uses a database advisory transaction lock plus a unique month rollover record, so parallel processes or retries return `noop` rather than create duplicate seasons.

The scheduler needs no separate browser, UI, agent or third-party task. It runs inside the same production backend process that owns the Supabase service-role configuration. Set `LEGACYX_SEASON_SCHEDULER_ENABLED=false` only for controlled maintenance. `LEGACYX_SEASON_SCHEDULER_INTERVAL_MS=3600000` is the normal hourly interval.

## MatchZy synchronization

MatchZy may keep `legacyx_rank_season` as a local fallback label, but the backend overwrites each accepted final map result with the current active database season before rank/XP/clan processing. This protects against a server that was not restarted immediately after rollover and guarantees that a completed map is attributed to exactly one active season.

## Safety and manual operation

The staff endpoint `POST /api/seasons/rollover` is disabled unless `ALLOW_MANUAL_SEASON_ROLLOVER=true`. Keep it disabled in normal production. If an emergency rollover is required, first ensure no in-flight MatchZy map is about to post its final result, enable the flag temporarily, call the endpoint with the operator API secret, confirm `status: rolled_over`, and turn the flag back off.

Apply `legacy_x_monthly_rank_reset.sql` only after `legacy_x_rank.sql` and `legacy_x_progression_clans.sql`. Then restart the API process and inspect `/health` plus `GET /api/seasons/current` with an operator token.
