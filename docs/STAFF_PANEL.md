# LEGACY-X Staff Panel

## Security Model

`legacy_x.users` is the normal identity table only. Staff eligibility does **not** use `users.role`. The additive `legacy_x.staff` table owns the staff record, active/suspended/revoked status, canonical staff role and optional permissions. `staff.user_id` references `users.id`.

The `/staffpanel` entry point always begins a fresh Steam OpenID flow. It does not trust a previous website access token, refresh token or browser role. After Steam returns, the Root API resolves `steam_id → users → staff`. Only an `active` `OWNER` or `MANAGER` record receives the short-lived, HttpOnly `legacyx_staff_session` cookie. Users without an active eligible staff record redirect to `/`.

| Staff role | Access |
|---|---|
| `OWNER` | Database metadata, product lifecycle, system/repository metadata, all permitted server/player/match operations |
| `MANAGER` | Ban, unban, kick, mute, rename, map change, match/HUD/player announcement, including player HUD alerts, subject to explicit permissions when populated |
| `ADMIN`, `DEVELOPER`, `DESIGNER`, no staff record, inactive record | Redirect to `/`; no staff session or `/api/v1/staffpanel/*` access |

Normal frontend hiding is not authorization. Every staff endpoint verifies the isolated cookie, current active staff record, role and capability server-side.

## Action Queue

Browser requests never contain shell, SQL, RCON or arbitrary console commands. The API validates a finite action type, normalizes structured fields, records an immutable audit entry and creates a `staff_panel_actions` queue row.

| Action | Role |
|---|---|
| `ban`, `unban`, `kick`, `mute`, `rename`, `map_change`, `server_announcement`, `match_announcement`, `hud_announcement`, `player_hud_alert`, `player_message` | `MANAGER` or `OWNER` |
| `restart_all`, `restart_server`, `start_server`, `stop_server`, `timeout`, `round_restart`, `round_restore`, `player_ip_lookup` | `OWNER` only |

Every operation requires an explicit browser confirmation that displays the target server and relevant player, map or message fields before it is queued. An action then stays `pending` until a future server-side, scoped plugin executor claims it. This source package deliberately does **not** report an action as successful before a game-server executor acknowledges it. Start/stop process control, IP disclosure and game-specific command semantics require the future VPS/CS2 executor integration and a real-server validation.

Staff can request a server-specific roster only through the isolated staff session. A player row must be selected before a player action is enabled. Ban requests require a finite term, a reason and the fixed ten-second player notice; kick and communication actions require a reason/message. A player HUD alert carries only allowlisted text, color and optional countdown fields. The future plugin executor must render `Owner` or `Manager` from the authenticated queue requester rather than accepting a browser-provided actor label.

The API rejects any queue request whose target server is not a registered server record. The future scoped executor must revalidate the claimed target server, player connection state and supported action fields before it sends a CS2-side notification or enforcement command; an expired roster snapshot or an unavailable player must result in a failed acknowledgement rather than a guessed execution.

## Deferred Rollout Order

1. Apply `supabase/legacy_x_staff_panel.sql` using the authorized production Supabase connection. The current MCP authorization issue means this status is **unknown**; do not assume it applied.
2. Create active `legacy_x.staff` records for the intended Owner/Manager users. Do not add staff data to `users.role`.
3. Deploy the backend, then the frontend. Verify a non-staff Steam account redirects from `/staffpanel` to `/` and an active Owner/Manager receives only the staff cookie.
4. Provision a scoped plugin token and a future CS2 action executor. Validate one action at a time on a staging server, including queue claim, result acknowledgement and audit record.
5. Enable sensitive Owner controls—restart, timeout and IP lookup—only after the VPS executor has an explicit allowlist, OS service identity and operator approval.

## Required Validation

The source package must pass the backend typecheck/build, staff route authentication contract and frontend build before commit. A full authenticated production test remains blocked until Supabase access and a VPS/CS2 server are available.
