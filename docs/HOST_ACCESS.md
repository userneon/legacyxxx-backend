# Host access for Staff → Host

The Owner's **Host** tab shows what is installed and loaded on the game host and can run **Deploy** and **Restart**.
The API reaches the host over SSH with a key that can run **one script only**.

## What the key can do

`legacyxxx-plugins/scripts/legacyx-host.sh` accepts three words and nothing else:

| Word | Does |
| --- | --- |
| `status` | read only: repository, deployed commit, each server, each plugin loaded or not, Metamod / CounterStrikeSharp / MultiAddonManager / .NET, the Workshop addon, the plugin `.env` (names only), disk |
| `deploy` | `git pull --ff-only` and `scripts/deploy.sh` (does not restart a server) |
| `restart <port>` | `systemctl restart cs2@<port>`, only for a port that has `/etc/legacyx/cs2/<port>.conf` |

Because `authorized_keys` forces the script (`restrict,command=…`), a stolen key still cannot open a shell, forward a port or run anything else.

## Set up (on the host, as root)

```bash
# 1. a key pair for the API (the private half stays on the API machine)
ssh-keygen -t ed25519 -N '' -C legacyx-site -f /etc/legacyx/host_key       # run this on the API machine
chmod 600 /etc/legacyx/host_key

# 2. on the game host: allow only the script
echo 'restrict,command="/root/legacyxxx-plugins/scripts/legacyx-host.sh" '"$(cat /etc/legacyx/host_key.pub)" >> /root/.ssh/authorized_keys
```

Then in the API's `.env`: `HOST_SSH_HOST`, `HOST_SSH_KEY=/etc/legacyx/host_key` (the path, not the key), optionally `HOST_SSH_USER`, `HOST_SSH_PORT`, `HOST_SSH_KNOWN_HOSTS`, and restart the API.
If the API and the game host are the same machine, `HOST_SSH_HOST=127.0.0.1` works.

Never put the private key in the repository, in `.env` as text, or in a chat. Both routes are Owner only, rate limited, and each action is written to `audit_logs` (`host.deploy`, `host.restart`).

## Several hosts (the web VPS and each game VPS)

Set `HOST_SSH_HOSTS` (JSON) instead of `HOST_SSH_HOST`; the Host tab then shows one block per machine:

```
HOST_SSH_KEY=/etc/legacyx/host_key
HOST_SSH_HOSTS=[{"id":"web","kind":"web","label":"Web","host":"127.0.0.1"},{"id":"game1","kind":"game","label":"Game 1","host":"203.0.113.20"}]
```

- `kind: "game"` runs `legacyxxx-plugins/scripts/legacyx-host.sh` (above). One `authorized_keys` line per game VPS.
- `kind: "web"` runs `ops/legacyx-web.sh` of this repository: status of pm2 (API, Discord bot), `/health`, Nginx, the three repositories (behind GitHub?), last deploys, disk; actions `deploy api|bot|site|admin` and `restart api|bot|nginx`.
  Deploys run in the background (the API's own deploy restarts the API), so the answer is "started"; press Check again after a minute.
  On the web VPS itself use `127.0.0.1`: `echo 'restrict,command="/path/to/legacyxxx-backend/ops/legacyx-web.sh" '"$(cat /etc/legacyx/host_key.pub)" >> ~/.ssh/authorized_keys` (the account that owns pm2 and the repositories).
  Optional `/etc/legacyx/web.conf` (`KEY=value` lines): `BACKEND_DIR`, `FRONTEND_DIR`, `BOT_DIR` (default: next to the backend), `RUN_AS` (the user that owns pm2 when SSH comes in as root).
- A new game VPS = one more `authorized_keys` line there and one more item in the list; no code change.
