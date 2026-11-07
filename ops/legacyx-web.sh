#!/usr/bin/env bash
# legacyx-web.sh: the ONLY thing the website's SSH key may run on the web VPS (API, website, staff site, Discord bot).
# Owner request 2026-11-07: "the API should know and manage its own VPS too". Same idea as legacyxxx-plugins/scripts/legacyx-host.sh.
#
# Force it in authorized_keys so the key can do nothing else:
#   restrict,command="/path/to/legacyxxx-backend/ops/legacyx-web.sh" ssh-ed25519 AAAA... legacyx-site
# Words (SSH command):  status | deploy <api|bot|site|admin> | restart <api|bot|nginx>
# A deploy runs in the background (the API's own deploy restarts the API, which would cut this connection); its log is in status.
# Settings (optional file /etc/legacyx/web.conf, plain KEY=value lines):
#   BACKEND_DIR FRONTEND_DIR BOT_DIR   where the three repositories are (default: next to this repository)
#   RUN_AS                             the user that owns pm2 and the repositories (default: the user running this script)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "${WEB_CONF:-/etc/legacyx/web.conf}" ]] && source "${WEB_CONF:-/etc/legacyx/web.conf}"
BACKEND_DIR="${BACKEND_DIR:-$HERE}"
FRONTEND_DIR="${FRONTEND_DIR:-$(dirname "$BACKEND_DIR")/legacyxxx-frontend}"
BOT_DIR="${BOT_DIR:-$(dirname "$BACKEND_DIR")/legacyxxx-discord-bot}"
RUN_AS="${RUN_AS:-}"
STATE_DIR="${STATE_DIR:-/var/lib/legacyx/web}"
export BACKEND_DIR FRONTEND_DIR BOT_DIR RUN_AS STATE_DIR
mkdir -p "$STATE_DIR" 2>/dev/null || true

line="${SSH_ORIGINAL_COMMAND:-$*}"
read -r action arg extra <<<"$line"
fail() { printf '{"ok":false,"error":"%s"}\n' "$1"; exit "${2:-2}"; }
[[ -z "${extra:-}" ]] || fail "too many words"

as_user() { if [[ -n "$RUN_AS" && "$(id -un)" != "$RUN_AS" ]]; then runuser -u "$RUN_AS" -- "$@"; else "$@"; fi; }
export -f as_user 2>/dev/null || true

dir_of() { case "$1" in api) echo "$BACKEND_DIR" ;; bot) echo "$BOT_DIR" ;; site|admin) echo "$FRONTEND_DIR" ;; esac; }
script_of() { case "$1" in api|bot|site) echo ops/deploy.sh ;; admin) echo ops/deploy-admin.sh ;; esac; }
pm2_of() { case "$1" in api) echo legacy-x-api ;; bot) echo legacy-x-discord ;; esac; }

status() {
  RUN_AS="$RUN_AS" python3 - <<'PY'
import datetime, json, os, re, shutil, subprocess

STATE = os.environ["STATE_DIR"]; RUN_AS = os.environ.get("RUN_AS", "")
REPOS = {"api": os.environ["BACKEND_DIR"], "bot": os.environ["BOT_DIR"], "site": os.environ["FRONTEND_DIR"]}
checks, info = [], {}

def run(cmd, timeout=25):
    if RUN_AS and os.geteuid() == 0 and cmd[0] != "systemctl":
        cmd = ["runuser", "-u", RUN_AS, "--"] + cmd
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""

def chk(cid, label, status, detail=""):
    checks.append({"id": cid, "label": label, "status": status, "detail": detail})

def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle: return handle.read()
    except Exception:
        return ""

# --- pm2 ---
try: apps = {a["name"]: a for a in json.loads(run(["pm2", "jlist"]) or "[]")}
except Exception: apps = {}
for key, name, label in (("api", "legacy-x-api", "API process"), ("bot", "legacy-x-discord", "Discord bot process")):
    app = apps.get(name)
    if not app: chk(f"pm2-{key}", label, "fail", f"pm2 has no {name}"); continue
    env = app.get("pm2_env", {}); online = env.get("status") == "online"
    up = int((datetime.datetime.now().timestamp() * 1000 - env.get("pm_uptime", 0)) / 1000) if online else 0
    detail = f"online {up // 3600}h {up % 3600 // 60}m, {env.get('restart_time', 0)} restarts, {app.get('monit', {}).get('memory', 0) // 1048576} MB" if online else str(env.get("status"))
    chk(f"pm2-{key}", label, "ok" if online else "fail", detail)

# --- repositories: GitHub ahead, and the last deploy of each target ---
info["repos"] = {}
for key, path in REPOS.items():
    if not os.path.isdir(os.path.join(path, ".git")): chk(f"repo-{key}", f"{ {'api':'Backend','bot':'Discord bot','site':'Frontend'}[key] } repository", "fail", "not found"); continue
    run(["git", "-C", path, "fetch", "-q", "origin", "main"], 25)
    head = run(["git", "-C", path, "rev-parse", "--short", "HEAD"]); behind = run(["git", "-C", path, "rev-list", "--count", "HEAD..origin/main"])
    behind_n = int(behind) if behind.isdigit() else None
    info["repos"][key] = {"commit": head, "behind": behind_n}
    label = {"api": "Backend", "bot": "Discord bot", "site": "Frontend"}[key]
    if behind_n is None: chk(f"repo-{key}", label, "warn", "could not compare with GitHub")
    elif behind_n > 0: chk(f"repo-{key}", label, "warn", f"{head}, {behind_n} newer commit(s) on GitHub: deploy")
    else: chk(f"repo-{key}", label, "ok", f"{head} is the latest")
for target in ("api", "bot", "site", "admin"):
    marker = read(os.path.join(STATE, f"deploy-{target}.json"))
    if not marker: continue
    try: data = json.loads(marker)
    except Exception: continue
    chk(f"deploy-{target}", f"Last {target} deploy", "ok" if data.get("ok") else "fail", f"{data.get('commit', '?')} at {data.get('at', '?')}" + ("" if data.get("ok") else ": failed, see the log"))
    info.setdefault("lastDeploy", {})[target] = data

# --- the API answers ---
port = (re.search(r"^PORT=(\d+)", read(os.path.join(REPOS["api"], ".env")), re.M) or [None, "3000"])[1]
health = run(["curl", "-fsS", "-m", "5", f"http://127.0.0.1:{port}/health"], 8)
chk("health", "API /health", "ok" if health else "fail", "answers" if health else f"no answer on port {port}")

# --- nginx, web roots, disk, node ---
chk("nginx", "Nginx", "ok" if run(["systemctl", "is-active", "nginx"]) == "active" else "fail", run(["systemctl", "is-active", "nginx"]) or "unknown")
for key, root in (("site", "/var/www/legacyx"), ("admin", "/var/www/legacyx-admin")):
    chk(f"web-{key}", "Website files" if key == "site" else "Staff site files", "ok" if os.path.isfile(os.path.join(root, "index.html")) else "warn", root if os.path.isfile(os.path.join(root, "index.html")) else f"{root}/index.html missing")
for key in ("api", "bot"):
    names = [m.group(1) for m in re.finditer(r"^([A-Z0-9_]+)=", read(os.path.join(REPOS[key], ".env")), re.M)]
    chk(f"env-{key}", f"{'API' if key == 'api' else 'Bot'} .env", "ok" if names else "fail", f"{len(names)} settings set (names only are ever read)" if names else "missing or empty")
free = round(shutil.disk_usage("/").free / 1e9, 1)
chk("disk", "Disk space", "fail" if free < 3 else ("warn" if free < 10 else "ok"), f"{free} GB free")
info["node"] = run(["node", "-v"])
info["actions"] = [{"action": "deploy", "target": t, "label": l} for t, l in (("api", "Deploy API"), ("site", "Deploy website"), ("admin", "Deploy staff site"), ("bot", "Deploy Discord bot"))] + [{"action": "restart", "target": t, "label": l} for t, l in (("api", "Restart API"), ("bot", "Restart Discord bot"), ("nginx", "Reload Nginx"))]
print(json.dumps({"ok": True, "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "checks": checks, "info": info}))
PY
}

lock() { exec 9>"$STATE_DIR/web.lock" 2>/dev/null || exec 9>/tmp/legacyx-web.lock; flock -n 9 || fail "another action is running" 3; }

case "$action" in
  status) status ;;
  deploy)
    [[ "${arg:-}" =~ ^(api|bot|site|admin)$ ]] || fail "no such target"
    dir="$(dir_of "$arg")"; script="$(script_of "$arg")"
    [[ -f "$dir/$script" ]] || fail "deploy script not found"
    lock
    log="$STATE_DIR/deploy-$arg.log"
    # Detached: the API's own deploy restarts the API that is waiting for this answer.
    ( setsid bash -c '
        cd "$1" && if as_user bash "$2" >"$3" 2>&1; then ok=true; else ok=false; fi
        printf "{\"ok\":%s,\"commit\":\"%s\",\"at\":\"%s\"}\n" "$ok" "$(git -C "$1" rev-parse --short HEAD 2>/dev/null)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$4"
      ' _ "$dir" "$script" "$log" "$STATE_DIR/deploy-$arg.json" 9>&- </dev/null >/dev/null 2>&1 & )
    printf '{"ok":true,"log":"Deploy of %s started. It runs in the background: check again in a minute (log: %s)."}\n' "$arg" "$log" ;;
  restart)
    case "${arg:-}" in
      api|bot) out="$(as_user pm2 restart "$(pm2_of "$arg")" --update-env 2>&1 | tail -n 8)"; rc=${PIPESTATUS[0]} ;;
      nginx) nginx -t >/dev/null 2>&1 || fail "nginx config test failed"; out="$(systemctl reload nginx 2>&1 && echo "nginx reloaded")"; rc=$? ;;
      *) fail "no such target" ;;
    esac
    python3 -c 'import json,sys; print(json.dumps({"ok": sys.argv[1] == "0", "log": sys.stdin.read()[-3000:]}))' "$rc" <<<"$out" ;;
  *) fail "unknown action" ;;
esac
