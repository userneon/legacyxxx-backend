#!/usr/bin/env bash
# LEGACY-X v3.0: a check every 10 minutes (cron): the API answers, the website answers, pm2 apps are online, the certificate has 14+ days left,
# the disk is under 85%. A problem is posted ONCE to the Discord update webhook (DISCORD_ANNOUNCE_WEBHOOK in /etc/legacyx/announce.env,
# the same file announce.sh uses) and once more when it is fixed. Silent when all is well.
#
# It cannot tell you the VPS itself is gone (a dead VPS runs nothing). For that use a free outside monitor (UptimeRobot, BetterStack)
# on https://legacyx.cc and https://api.legacyx.cc/health, and put the VPS renewal date in a calendar with an alarm a week before (docs/V3_REBUILD.md).
set -uo pipefail
DOMAIN="${DOMAIN:-legacyx.cc}"
STATE="/var/lib/legacyx/watch.state"
mkdir -p /var/lib/legacyx
problems=()

curl -fsS --max-time 8 http://127.0.0.1:3000/health >/dev/null 2>&1 || problems+=("the API does not answer /health")
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: $DOMAIN" http://127.0.0.1/ 2>/dev/null)"
[[ "$code" =~ ^(200|301|302)$ ]] || problems+=("the website answers HTTP $code")
if command -v pm2 >/dev/null; then
  for app in legacy-x-api legacy-x-discord; do
    st="$(runuser -u legacyx -- pm2 jlist 2>/dev/null | python3 -c "import sys,json
try:
  for p in json.load(sys.stdin):
    if p.get('name')=='$app': print(p['pm2_env']['status'])
except Exception: pass" 2>/dev/null)"
    [[ "$st" == "online" ]] || problems+=("$app is ${st:-not in pm2}")
  done
fi
end="$(echo | openssl s_client -servername "$DOMAIN" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
if [[ -n "$end" ]]; then
  days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  (( days >= 14 )) || problems+=("the HTTPS certificate ends in $days days")
fi
use="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
(( use < 85 )) || problems+=("the disk is ${use}% full")

now="$(printf '%s; ' "${problems[@]}")"
before="$(cat "$STATE" 2>/dev/null || true)"
printf '%s' "$now" > "$STATE"
[[ "$now" == "$before" ]] && exit 0
url="$(sed -n 's/^DISCORD_ANNOUNCE_WEBHOOK=//p' /etc/legacyx/announce.env 2>/dev/null | tail -n1 | tr -d '\r\n ')"
[[ "$url" =~ ^https://(canary\.|ptb\.)?discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$ ]] || exit 0
if [[ -n "$now" ]]; then msg="Web VPS problem: $now"; else msg="Web VPS is fine again."; fi
curl -fsS --max-time 10 -H 'Content-Type: application/json' -d "$(python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1][:1800]}))' "$msg")" "$url" >/dev/null 2>&1 || true
