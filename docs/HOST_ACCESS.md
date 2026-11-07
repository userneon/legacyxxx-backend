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
