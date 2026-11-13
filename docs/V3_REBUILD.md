# LEGACY-X v3.0: rebuild the web VPS from nothing

Why this exists: in 2026-11 the web VPS was not renewed and was deleted. The code (GitHub) and every player's data (Supabase) were safe; the server, its
Nginx setup and its `.env` files (all the secrets) were gone, and the only backups of those lived on the same VPS. v3.0 makes the rebuild two commands
and keeps the secrets somewhere that survives the server.

The game servers (cs2) are a **different** VPS and have their own script (`legacyxxx-plugins/scripts/cs2-host.sh`). This page is the web VPS: website,
staff site, API, Discord bot.

## What survives, what does not

| Safe without any VPS | Lost with the VPS |
|---|---|
| All code (GitHub: backend, frontend, bot, plugins, workshop) | The server itself, Nginx sites, certificates |
| The database and every player's data (Supabase) | Every `.env` (API, bot) and the keys inside |
| The Workshop addon (Steam) | The bot's `data/` (panels, settings, honeypot, voice, LFG state) |
| Wire account, Discord application, Steam key at their own sites | pm2 list, cron, `/etc/legacyx` |

## Rebuild: step by step

1. **Buy a VPS** (Ubuntu 22.04 or 24.04, 2 vCPU / 4 GB is plenty). Turn **auto-renew ON** and put the renewal date in your calendar with an alarm 7 days before (see "Never again").
2. **DNS**: point `legacyx.cc`, `www`, `api`, `admin`, `static` (A records) at the new IP. Wait until `getent hosts api.legacyx.cc` shows it.
3. **On the VPS as root**:
   ```bash
   git clone https://github.com/userneon/legacyxxx-backend.git /root/lx && cd /root/lx
   sudo bash ops/v3-bootstrap.sh prepare
   ```
   This installs Node 22, Nginx, pm2, certbot, the firewall and fail2ban, makes the `legacyx` user, clones the four repositories into `/opt/legacyx`, writes the
   Nginx sites and creates both `.env` files with a **new random `JWT_SECRET`** and the fixed values. Anything that must come from a service says `__FILL__`.
   If a repository is private, give the VPS a read-only **deploy key** (GitHub repo → Settings → Deploy keys) or clone with `GIT_BASE=https://<token>@github.com/userneon`
   (never write a token into a repository).
4. **Fill the two `.env` files** (table below): `/opt/legacyx/legacyxxx-backend/.env` and `/opt/legacyx/legacyxxx-discord-bot/.env`.
5. **HTTPS**: `sudo CERT_EMAIL=you@example.com bash ops/v3-bootstrap.sh certs`
6. **Start everything**: `sudo bash ops/v3-bootstrap.sh finish` (refuses while any `__FILL__` is left). It builds and starts the API (pm2), the website, the staff site and the bot,
   sets pm2 to start on boot, installs the nightly backup and the 10-minute watch. Check with `sudo bash ops/v3-bootstrap.sh status` and open https://legacyx.cc.

## Every value, and where to get it again

| Variable (file) | Where it comes from | If it is new |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (API) | Supabase dashboard → Project Settings → API | Same project, nothing is lost |
| `STEAM_WEB_API_KEY` (API) | https://steamcommunity.com/dev/apikey (domain `legacyx.cc`) | A new key is fine |
| `JWT_SECRET` (API) | made by the script | **Every player signs in again once** (expected) |
| `DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_CLIENT_SECRET`, `DISCORD_OAUTH_REDIRECT_URI` (API) | Discord Developer Portal → your application → OAuth2 (redirect `https://api.legacyx.cc/api/v1/auth/discord/callback`) | Reset the secret if lost |
| `WIRE_API_KEY`, `WIRE_WEBHOOK_SECRET` (API) | wire.mn dashboard; the webhook URL there stays `https://api.legacyx.cc/api/v1/public/wire/webhook` | Re-issue in Wire |
| `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (API) | Apple Developer → Keys (the `.p8` can be downloaded **once**; if lost, make a new key) | Put the `.p8` on the VPS, `chmod 600`, never in Git |
| `HOST_SSH_HOSTS`, `HOST_SSH_KEY`, `HOST_SSH_KNOWN_HOSTS` (API) | `docs/HOST_ACCESS.md`: new key for the site, `authorized_keys` line on each game VPS, and on the web VPS (`ops/legacyx-web.sh`) | New key pair, re-authorize on every host |
| `CHECKER_*`, `KIT_RENDER_*` (API, optional) | the checker installer files and render folder; see `ENVIRONMENT.example` | Re-upload the installer if you use it |
| `DISCORD_TOKEN`, `GUILD_ID` (bot) | Discord Developer Portal → Bot → Reset Token; the server ID (Developer Mode → copy ID) | Reset the token (the old one stops working) |
| `API_TOKEN` (bot) | made on the VPS with the API: see the comment above `API_TOKEN` in the bot's `.env.example` (scopes `bans:write`, `discord:link`) | Make a new one |
| `ANTHROPIC_API_KEY` (bot, optional) | console.anthropic.com | New key |
| `DISCORD_ANNOUNCE_WEBHOOK` (`/etc/legacyx/announce.env`) | Discord channel → Integrations → Webhooks; set with `legacyxxx-plugins/scripts/announce.sh` | New webhook |

The game servers' own `.env` (plugins) are on the game VPS and were not touched. After the API is back, every game server reads the API again by itself. If a game server
shows API errors, check that its API token still exists in the API's token list (a token made before the rebuild is stored in Supabase, so it still works).

## After the first start

- Sign in on https://legacyx.cc with Steam once; confirm Home, Leaders, a profile and the Shop load real data.
- Staff site https://admin.legacyx.cc; Staff → Host: add the web VPS (`kind: web`) again if you use it (`docs/HOST_ACCESS.md`).
- Discord bot: it keeps its panels in Discord, but its `data/` (rank-role IDs, settings, honeypot, voice, LFG) is rebuilt empty: run `/welcome show` and `/status`, and re-run the
  `/…-setup` commands you use. It re-creates the rank roles if `data/rank-roles.json` is gone (it may make duplicates: delete the old ones by hand).
- Set the nightly backup's **off-VPS copy** (next section) and copy `/etc/legacyx/backup.pass` to your password manager.

## Never again

1. **Auto-renew + a calendar alarm a week before** the VPS renewal date. Use a payment method that does not expire. This is the one thing no script can do from inside the VPS.
2. **An outside monitor** (UptimeRobot or BetterStack, free) on `https://legacyx.cc` and `https://api.legacyx.cc/health`, alerting your phone. A dead VPS cannot report itself.
3. **Backups that leave the VPS**: `sudo bash ops/v3-backup.sh setup-remote user@your-other-host:/backups/legacyx` (it makes an SSH key and prints the public half to authorize there),
   or copy `sudo bash ops/v3-backup.sh bundle` to your PC with `scp` every week. The bundle is encrypted; the passphrase `/etc/legacyx/backup.pass` goes to a password
   manager, **not** only on the VPS. Try a restore once (`restore <file> /tmp/x`) so you know it works.
4. **Keep a password-manager entry per service** (Supabase, Steam key, Discord app, Wire, Apple, the hosting account, the domain registrar, this VPS's root key). The `.env` files are a copy of those, not the master.
5. **The domain registrar** is a second thing that expires: auto-renew it too.
6. `ops/v3-watch.sh` (cron, every 10 minutes) posts to the update webhook when the API or website stops answering, pm2 apps go down, the certificate has less than 14 days left or the disk passes 85%.
