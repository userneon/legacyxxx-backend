# Live Server Match Panel Audit — 2026-08-24

The current public server API reads `legacy_x.reconnect_servers` and exposes only server identity, connection address, current map, mode, aggregate player count, heartbeat-based status, and a fixed maximum player count. It does **not** expose a current round, team score, or per-team live roster.

The existing Match Core schema already preserves authoritative competitive match state without mock data. `core_matches` stores server identity, map, and state; `core_match_slots` stores active player assignments by `team_key` (`team1` / `team2`) and slot; `core_match_participants` stores original player identity and connection state. It does not currently persist a single server-wide, real-time round/score snapshot for a public panel.

The Reconnect plugin already records actual connected-player sessions in `reconnect_sessions`; those rows provide a truthful general-server player name and connection-state list keyed by server. The current heartbeat has only aggregate `player_count`, map, and mode; it does not report team, round, or score. A public panel can therefore list connected players now, but must report team/round/score as unavailable until the plugin sends an explicitly validated snapshot.

The match panel must therefore render only actual active Match Core slots and persistent match state until the game plugin publishes an explicitly validated real-time snapshot containing round and score data. When none exists, the UI must show an explicit unavailable/empty state rather than generated player names or fabricated scores.

## Confirmed Data Boundary

| Requirement | Existing authoritative source | Current availability |
|---|---|---|
| Server map | `reconnect_servers.current_map` | Available |
| Online count | `reconnect_servers.player_count` | Available |
| Active competitive roster | `core_match_slots` + `core_match_participants` + `users` | Available only for Match Core matches |
| General connected-player roster | `reconnect_sessions` where `disconnected_at IS NULL` | Available |
| T/CT mapping | Existing `team1` / `team2` keys | Requires UI labels / plugin convention mapping |
| Current round | None | Requires plugin snapshot field |
| Current score | None | Requires plugin snapshot field |

## Implemented Read/Write Boundary

An additive `server_live_match_snapshots` table is now available for authenticated Reconnect-plugin heartbeat snapshots. It is RLS-enabled; `anon` cannot read it, `authenticated` cannot write it, and only the Root API service role has access. The public Root API resolves a server modal in the following order: a validated live snapshot if one has arrived; otherwise the real connected-player list from `reconnect_sessions`; otherwise a clear unavailable state. It never creates example teams, score, round, or player names.

The frontend Info action opens a centered liquid-glass dialog over a blurred backdrop. The map art is deliberately low opacity, while the supplied map badge and Terrorist/Counter-Terrorist artwork remain bright. These supplied visual assets are stored under stable project static URLs, rather than copied as local deployment payloads.
