# Ranked match telemetry — `competitive_result` v2

The CS2 Match Core module sends raw match telemetry; the API calculates EXP (`server/legacyX/rank/exp.ts`) and
applies it atomically (`legacy_x.apply_competitive_match_exp`). The plugin never calculates or sends EXP or rank.

## Event lifecycle

```text
match_created (10 original participants)
  → state_transition LIVE
  → player_disconnected / player_returned / fill_assigned / snapshot_saved   (any number)
  → result_final  (carries result.competitive_result v2)        → EXP applied once
  or match_cancelled                                             → no EXP
```

All events go to `POST /api/v1/plugin/match-core/events` with the plugin bearer token and
`x-plugin-id: legacyx-match-core`. Every event has a unique `event_id`; resending the same event is safe
(`duplicate`), and `expected_revision` keeps events in order (`stale` means re-read the match and resend).

## `result_final` → `result.competitive_result`

```jsonc
{
  "schema_version": 2,
  "mode": "5v5",                 // "5v5" | "pro_league" | "fun"  (fun never changes EXP)
  "finished_normally": true,     // false after cancel / crash / forced end
  "human_players_at_end": 10,    // bots excluded
  "total_rounds": 22,
  "team1": { "rounds_won": 13, "short_handed_rounds": 0 },   // short_handed_rounds optional
  "team2": { "rounds_won": 9 },
  "unavailable_fields": ["bomb_plants", "bomb_defuses"],      // counters this build cannot collect
  "players": [
    {
      "steam_id": "76561198000000001",
      "team": "team1",
      "is_bot": false,
      "fill": false,               // joined mid-match to replace a leaver
      "rounds_played": 22,         // rounds this player was on the team at round start
      "kills": 21, "deaths": 14, "assists": 5, "headshot_kills": 11,
      "entry_kills": 4,
      "bomb_plants": 2, "bomb_defuses": 0,
      "rounds_3k": 2, "rounds_4k": 0, "rounds_5k": 0,
      "clutches_won": 1, "clutches_won_1v3_plus": 0,
      "mvps": 4,
      "left_early": false,         // left and did not return inside the rejoin window
      "left_at_round": null
    }
  ]
}
```

Validation (API): SteamIDs unique, `rounds_played ≤ total_rounds`, round wins ≤ total rounds, counters bounded.
A result without `competitive_result` is stored as the match result but applies no EXP
(`competitive: { status: "skipped", reason: "competitive_result_missing" }`) — nothing is guessed.

## Missing telemetry rule

If a counter is absent/`null` for any human or listed in `unavailable_fields`, its term is dropped from the
lobby-relative `score` for everyone and recorded in `exp_breakdown.omittedTerms` and the receipt summary.
Validity (`finished_normally`, `human_players_at_end`, `total_rounds`) and `rounds_played` / `left_early` are
required: without them a match cannot be judged, so the payload is rejected.

## What the plugins send (legacyxxx-plugins, `main`)

`LegacyX-MatchZy/LegacyXRankTelemetry.cs` builds `competitive_result` v2 for `result_final`. Team keys are the
Match Core keys (team1 = the side that started CT); MatchZy's own team order is mapped onto them.

| Field | Source | Status |
|---|---|---|
| kills / deaths / assists / headshot_kills | `MatchStats` (kept when a player disconnects) | sent |
| entry_kills | `MatchStats.EntryWins` | sent |
| rounds_3k / 4k / 5k | `MatchStats.Enemy3Ks/4Ks/5Ks` | sent |
| clutches_won / clutches_won_1v3_plus | last player alive per side at death time, won round | sent |
| bomb_plants / bomb_defuses | `EventBombPlanted` / `EventBombDefused` | sent |
| rounds_played (per player) | +1 per round end while on T/CT | sent |
| left_early / left_at_round | disconnect round; cleared on return | sent |
| fill | not an original Match Core participant | sent |
| mvps | `player.MVPs` | sent |
| human_players_at_end, total_rounds, mode | connected humans, map rounds, `LEGACYX_SERVER_MODE` | sent |
| finished_normally | `true` from the normal series end | sent (forfeits/cancellations don't reach `result_final`) |
| short_handed_rounds | not sent; the API derives it from `left_at_round` | derived |

`unavailable_fields` is empty: every optional counter is reported.

## Kill feed

`POST /api/v1/plugin/killfeed/events` (same token): one object or an array of up to 50:
`{ event_id, server_id, attacker_steam_id?, attacker_name, victim_steam_id?, victim_name, weapon, headshot, timestamp }`.
Kills are held in memory only (last 50) and are never stored. `LegacyX-Reconnect` sends them in batches every
2 seconds (`LEGACYX_RECONNECT_KILLFEED_ENABLED`, default on).

## Server capacity

`server_heartbeat` on `/api/v1/plugin/reconnect/events` may add `max_players` (`Server.MaxPlayers`) and
`gotv_address` (`LEGACYX_GOTV_ADDRESS`); `LegacyX-Reconnect` sends both. Without them the Play page assumes 10 slots
(16 for Fun servers) and hides Spectate.

## Live match snapshot

Players in `live_match` (heartbeat or `/plugin/live-match/snapshots`) may carry optional `kills`, `deaths` and
`assists`; the Play page's server details sheet shows them as K / D / A and a dash when absent.
