# LEGACY-X Unified Match System Runbook

## Purpose and ownership

The Unified Match System makes the **AdminPlus API and Supabase Match Core** the durable authority for match state. MatchZy remains responsible for real-time CS2 gameplay. It never writes database credentials, and it cannot resume a Match Core match while a configured original slot is missing or the backend has not acknowledged roster integrity.

| Layer | Responsibility | Must not do |
|---|---|---|
| MatchZy + Match Core bridge | Exact 5v5 snapshot, gameplay pause, reconnect restore, temporary-fill command, center overlays | Store service-role keys or grant rewards directly |
| AdminPlus API | Constant-time plugin authentication, request limits, contract validation, Supabase RPC invocation | Serve a public control panel or accept unauthenticated plugin events |
| Supabase `legacy_x` | Immutable event record, lifecycle state, original slots, temporary fills, player snapshots and reward eligibility | Expose Match Core tables to `anon` or `authenticated` roles |

> **State model:** `WAITING → LIVE → PAUSED → LIVE → FINISHED`, with `CANCELLED` available only from `LIVE` or `PAUSED`. Every write carries an expected revision, so stale server events cannot overwrite a newer state.

## One-time production database deployment

The following migrations have been applied to the configured production Supabase project in this order. Apply the same ordered set to any clean environment.

| Order | Migration | Purpose |
|---:|---|---|
| 1 | `legacy_x_adminplus.sql` | Server-only AdminPlus audit trail |
| 2 | `legacy_x_rank.sql` | Seasons, rank score, map result receipts and leaderboard |
| 3 | `legacy_x_progression_clans.sql` | XP, level, clan season score and receipts |
| 4 | `legacy_x_monthly_rank_reset.sql` | Idempotent UTC month rollover |
| 5 | `legacy_x_reconnect.sql` | Reconnect session, heartbeat and Last Played persistence |
| 6 | `legacy_x_match_core.sql` | Match lifecycle, original slots, snapshots and immutable Match Core events |
| 7 | `legacy_x_match_core_fill_lifecycle.sql` | Temporary-fill removal and original participant reward exclusion |
| 8 | `legacy_x_match_core_security_hardening.sql` | Revokes public execution of Match Core `SECURITY DEFINER` functions; grants execution only to `service_role` |

Validate after deployment with the following read-only query. It must return both functions with `prosecdef = true`.

```sql
SELECT p.proname, p.prosecdef
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'legacy_x'
  AND p.proname IN ('ingest_core_match_event', 'core_match_active_slots_ready')
ORDER BY p.proname
LIMIT 10;
```

## API service configuration

Copy `adminplus/backend/.env.example` to the production-only `.env`. Generate independent values for all three secrets. The Match Core secret is deliberately different from the normal MatchZy ingestion secret.

| Variable | Role | Production rule |
|---|---|---|
| `API_SECRET` | Operator API header secret | At least 32 characters; never in a game-server cfg |
| `PLUGIN_INGEST_SECRET` | Existing MatchZy, Community and Reconnect plugin ingestion | At least 32 characters; distinct from all other secrets |
| `MATCH_CORE_PLUGIN_SECRET` | `legacyx-match-core` server bridge ingestion | At least 32 characters; configured only in the private MatchZy cfg |
| `MATCH_CORE_RECONNECT_WINDOW_SECONDS` | Original participant reconnect grace period | Default `300`; permitted range 30–3600 |
| `MATCH_CORE_FILL_TIMEOUT_SECONDS` | Time before staff fill reminder | Default `120`; permitted range 30–3600 |

Run the API checks before restarting the process:

```bash
cd adminplus/backend
pnpm check
pnpm test:rank
pnpm test:reconnect
pnpm test:match-core
```

## CS2 MatchZy configuration

The tracked `matchzy/cfg/MatchZy/config.cfg` keeps Match Core disabled and secret-free by default. Copy `legacyx-match-core.private.cfg.example` to the gitignored `legacyx-match-core.private.cfg`, replace the placeholders, and execute the private cfg after the public config.

```cfg
legacyx_match_core_enabled true
legacyx_match_core_api_url "http://127.0.0.1:3001/api/plugin/match-core/events"
legacyx_match_core_plugin_secret "<MATCH_CORE_PLUGIN_SECRET>"
legacyx_match_core_server_id "legacyx-match-1"
```

The backend should be reachable only from the CS2 server or a protected private network. Do not place this API behind a public browser route. The plugin's Match Core request includes `x-plugin-id: legacyx-match-core` and its dedicated secret; normal MatchZy events continue to use the existing plugin ingress secret.

## Staff operating procedure

When an original participant disconnects during a live Match Core match, MatchZy captures the player state, records a disconnect event, and pauses the server. The original slot remains reserved for the configured reconnect window. On return, the player reconnects as the original, MatchZy restores the captured state, and both teams may resume only after the backend acknowledges all ten active slots.

If a replacement is necessary, an authorized operator may run the following server command after confirming the player is connected. The fill keeps the original slot's team but is never reward eligible.

```text
css_legacyx_fill <steamid64> <team1|team2> <slot 1-5>
```

If the temporary fill disconnects, MatchZy pauses the match and frees that active slot. The original participant remains reward-ineligible for that match once a temporary fill has been assigned; this prevents double credit or player-swapping abuse.

## Live smoke-test matrix

| Scenario | Expected result | Evidence to retain |
|---|---|---|
| Ten players, five CT and five T, all ready | Match Core creates `WAITING`, then enters `LIVE` | API event log and `core_matches` revision |
| Sixth player or 6v5 / 5v6 / 6v6 roster | Match does not start | MatchZy ready gate output |
| Original player disconnects live | Snapshot is saved; `PAUSED`; original slot empty | `core_match_events`, `core_match_player_snapshots` |
| Original player returns before deadline | Original slot restored; controlled state restore occurs | participant `returned_at`, updated revision |
| Player tries `.unpause` with a missing slot | Resume is blocked | MatchZy integrity message |
| Authorized temporary fill | Slot becomes `fill`; original is not reward eligible | `core_match_slots`, participant eligibility |
| Completed eligible final | Exactly one final event; rank + XP community receipts are idempotent | event IDs and receipt tables |
| Duplicate final POST | No second rank/XP write | `duplicate` response and unchanged receipt counts |

## Quiet competitive UX

The default configuration disables per-round damage reports. Players receive a short welcome center display on connect, a center-screen Match ID for the opening five minutes of live play, and one final chat line after the series is finalized. The classic three-line `LIVE!` spam is replaced by one concise status message.

## Known deployment boundary

Backend contracts, migration registration, and plugin compilation have been validated. A **real ten-player CS2 server smoke test** remains mandatory before declaring the flow operational for community users, because it validates actual CounterStrikeSharp event timing, RCON/network reachability, real player rejoin timing, and server map transition behavior.
