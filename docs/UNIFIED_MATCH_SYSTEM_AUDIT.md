# LEGACY-X Unified Match System Refactor — Audit

## Scope audited

This audit covered the deployed source structure in `legacyxxx-plugins` and `legacyxxx-backend`: LEGACY-X MatchZy, MatchZy local persistence and backup flows, AdminPlus API ingress, rank/community progression ingestion, Reconnect, AFK Manager, Spectator Comms and the existing Supabase migrations.

## Current-state findings

| Area | Current implementation | Gap against the new match specification |
|---|---|---|
| Match lifecycle | MatchZy tracks several mutable booleans (`readyAvailable`, `matchStarted`, `isWarmup`, `isMatchLive`, `isPaused`) and a numeric `liveMatchId`. | No single durable lifecycle state or backend-authoritative match UUID. Boolean combinations can represent ambiguous states. |
| Match identity | `liveMatchId` is generated/loaded by MatchZy local SQLite/MySQL persistence. | Local ID must not become the authoritative public match identity; result and history can diverge after restart or retry. |
| Participant identity | MatchZy team membership uses mutable JSON player collections; disconnect removes controller/ready entries. | There is no durable original-participant snapshot, reconnect window, temporary fill role or active-slot lock. |
| Pause/resume | MatchZy supports manual two-team `.unpause`, force pause and Valve round backup restore. | Current unpause does not validate exact restored 5v5 composition or original/fill eligibility. |
| Recovery | MatchZy saves a file-backed round snapshot with Valve backup text, match config, team state and scores. | It is useful as an engine recovery cache but it is not backend durable state and has no explicit player eligibility/rejoin policy. |
| Result/XP/rank | `map_result` updates rank and XP through two idempotent receipt tables. | A final map event is not an authoritative match record and lacks match status, participant provenance, fill exclusion and one-result-per-match semantics. |
| Reconnect | Reconnect tracks generic cross-server sessions and Last Played. | It does not know active match membership, original team/slot, pause window, fill replacement or state restoration. |
| Team integrity | MatchZy blocks ordinary `jointeam` changes for configured matches. | It does not model a roster slot lock that distinguishes original participants, temporary fills and spectators. |
| Chat/overlay | MatchZy prints per-round score and optional damage chat; rank/XP has no clean live HUD contract. | The requested silent reward policy, welcome overlay, five-minute match number overlay and one final summary are not centralized. |

## Decisions

1. **MatchZy remains the rules engine.** It retains CS2 live config, round control, demo recording, Valve round backup and map transition. A new `LegacyXMatchCore` must not duplicate MatchZy lifecycle commands.
2. **Backend becomes the authoritative match ledger.** A UUID `match_id`, lifecycle status, frozen participant snapshot, team assignment, reconnect/fill state, events and final result are persisted in Supabase. The numeric MatchZy local ID remains a recovery/reference field only.
3. **One final result is authoritative.** Rank, XP, clan points and match history process only from an idempotent final result event emitted after backend state moves to `FINISHED`.
4. **Reconnect is eligibility-first.** A disconnected original participant may reclaim only their stored team/slot during the configured window. A temporary fill is marked explicitly and cannot earn rank/XP or replace an original identity.
5. **No resume without integrity.** `PAUSED` cannot move to `LIVE` until the backend and plugin agree there are exactly five eligible active members per team. An original return replaces its fill; it cannot create 6v5/6v6.
6. **Server snapshots are recovery aids.** MatchZy Valve backups restore engine state after map/server disruption. Match Core stores the player-state metadata needed to reapply identity, team and recoverable health/armor/location/equipment after the engine has restored the round.
7. **Rewards are quiet.** No round-end XP/rank/damage broadcast is allowed in competitive play. Players receive a short welcome overlay, match identifier overlay and one post-match result/reward summary.

## Required new contract

```text
WAITING -> LIVE -> PAUSED -> LIVE -> FINISHED
                    |
                    +-> CANCELLED
```

Every state transition carries an event ID and expected state revision. The backend accepts a transition once, writes an immutable audit event, increments revision and returns the current canonical state. Plugins treat a timeout as unknown and re-fetch state; they never retry a reward/result blindly.

## Compatibility changes required

- Replace MatchZy direct pause/unpause delegation with Match Core integrity guards while preserving MatchZy command syntax.
- Suppress MatchZy damage and round-score broadcasts through LEGACY-X config rather than maintaining parallel chat hooks.
- Extend Reconnect from Last Played observer to Match Core state reporter; retain its existing server allowlist and secret isolation.
- Retain AFK Manager as a player-state signal only; it must never create a replacement, score a match or alter MatchZy map state.
- Retain Spectator Comms as communications routing only; its command pass-through must preserve MatchZy commands.

## Explicit non-goals

This refactor does not add a player-visible web panel, public social feed, paid gameplay advantage, automatic team balancing, rank reset outside the existing monthly season process or a second match manager.

## Live validation required after implementation

1. Original player disconnects in live 5v5: backend moves state to `PAUSED`; no XP/result is emitted.
2. Eligible original returns before timeout: same team/slot/state is restored, then integrity-gated resume succeeds.
3. Temporary fill joins: it can occupy only the missing original slot; returning original replaces it before resume.
4. No sixth player can join either side before or after resume.
5. Duplicate final event, API retry and process restart produce one final result and one reward set.
6. Backend failure, invalid state revision, wrong-team join and timeout keep the match paused or cancel it safely.
