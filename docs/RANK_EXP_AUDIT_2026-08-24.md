# LEGACY-X 18-Rank EXP Audit

> This document records the source-of-truth transition for the gameplay-authoritative competitive rank system. It is an additive migration plan: no existing user, match, rank-season, progression, or audit data is to be deleted.

## Approved competitive rules

The canonical competitive rank is cumulative EXP, not purchased credit, staff role, or client-side state. The exact thresholds are: Silver I 0; Silver II 1,000; Silver III 2,200; Silver IV 3,600; Silver Elite 5,200; Silver Elite Master 7,000; Gold Nova I 9,000; Gold Nova II 11,500; Gold Nova III 14,500; Gold Nova Master 18,000; Master Guardian I 22,000; Master Guardian II 26,500; Master Guardian Elite 31,500; Distinguished Master Guardian 37,000; Legendary Eagle 43,000; Legendary Eagle Master 50,000; Supreme Master First Class 58,000; Global Elite 67,000+.

Gameplay reward values are fixed by the supplied specification. They include match win/loss, round win, kill, assist, headshot, MVP, bomb/hostage objectives, clutch, first kill, 3+ multi-kill, and ace rewards. An Owner is never a competitive participant: no EXP, rank, competitive statistics, leaderboard record, or Pro League access is created for that role. Master Guardian I (rank 11) is the only Pro League gate.

## Current audited implementation

| Area | Existing behavior | Conflict with approved rules |
|---|---|---|
| `rank_player_seasons` | Stores seasonal ELO-style `rating`, wins/losses and map results. | It is not cumulative 18-rank EXP. |
| `community_player_progression` | Stores `experience` and an unbounded square-root `level`. | It creates a second progression authority with no named 18-rank threshold table. |
| `player_stats.experience` | Contains a legacy aggregate value used by current frontend leaders/profile responses. | It has no immutable reward ledger or rank calculation guarantee. |
| MatchZy `map_result` | Publishes per-map stats to `/plugin/matchzy/events`. | It has no final-series-only reward gate and lacks some required counters. |
| Match Core `result_final` | Publishes another nested `rank_result` when its roster is eligible. | It can overlap the MatchZy map result path and create double-reward risk. |
| `/leaders` | Uses community performance rows and currently renders positional placeholder rank badges. | It must read the canonical competitive rank and image key while preserving layout. |

## Data and security boundary

The live `legacy_x` project currently has existing users and player-stat rows but the audited rank/progression tables are effectively unused. This allows an additive canonical competitive ledger/state implementation without data deletion. Existing `rank_seasons`, monthly archives, community/clan progression, and legacy rating columns remain readable for compatibility; they are not the authoritative 18-rank result after rollout.

The production advisor reports RLS disabled on 24 older `legacy_x` tables, including `users` and `player_stats`. This is a separate critical security concern. It must be remediated with reviewed policies in a dedicated change; enabling RLS blindly is excluded from this rank rollout because it can break live Root API behavior.

## Canonical rollout boundary

The new system will use a static rank definition table, one player-owned cumulative competitive state row, an immutable event/action ledger, and a single server-authenticated final-match ingestion function. Each mutation is idempotent at event and player-action scope. The Root API and plugin authenticate the game server; the browser only reads mapped profile/leaderboard data. Legacy MatchZy map events remain non-rewarding compatibility telemetry once the final-match event path is enabled.

## Applied implementation and validation

The production database now contains 18 static rank definitions, an initially empty player progression table, immutable EXP ledger, idempotent event receipt table, canonical profile/leaderboard views, and a `SECURITY DEFINER` final-match ingestion function. No existing user, match, legacy rank, community progression, player-stat, or feedback row was deleted. The function accepts only a completed Match Core `result_final`, requires the stored final event, exactly ten original eligible players, no fill player, roster/team consistency, bounded integer counters, and one unique ledger row per event/player/action.

The root API sends a qualifying `result_final` to Match Core persistence first and then to competitive EXP ingestion. MatchZy map-result requests remain accepted as non-rewarding telemetry; consequently they cannot create a second EXP authority or duplicate reward. The MatchZy source now collects server-side round, death, bomb, hostage, multi-kill, ace, first-kill, clutch, and aggregate score counters into the final competitive payload. Its Release build completed with zero errors; pre-existing nullable/unreachable-code warnings remain outside the new module.

Read-only production threshold checks returned Silver I below 1,000, Silver II at 1,000, Gold Nova Master at 21,999, Master Guardian I with Pro League unlocked at 22,000, Master Guardian II at 26,500, Supreme Master First Class at 66,999, and Global Elite at 67,000. The backend TypeScript check and production bundle completed. The isolated Root API route contract test passed all six assertions. The frontend TypeScript/Vite production build completed.

The privilege audit initially found PostgreSQL's default `PUBLIC` function execute grant on the new award function. An immediate additive hardening migration revoked `PUBLIC`, `anon`, and `authenticated` execution from both Match Core and competitive functions, then granted execute only to `service_role`. Follow-up read-only verification confirms anonymous users cannot execute either ingestion function while `service_role` can. This preserves the required Browser → Root API → Database and Game Plugin → Root API → Database boundaries.

## Deployment caveats

The frontend understands rank image keys `rank-01` through `rank-18` and has a numeric fallback so missing artwork does not render as a broken image. The actual Rank1–Rank18 PNG files have not been supplied or found in the frontend repository, so final PNG rendering remains pending those source assets. The new plugin source is built locally but is intentionally not pushed until explicit plugin-repository push authorization is reconfirmed; no game server deployment was attempted.
