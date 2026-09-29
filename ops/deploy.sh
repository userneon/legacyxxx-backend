#!/usr/bin/env bash
# Deploy the LEGACY-X API on the VPS in one command: pull main, install, typecheck, build, reload pm2,
# then check /health.
#
#   bash ops/deploy.sh
#
# Override the defaults when yours differ:
#   BRANCH=main PORT=3000 bash ops/deploy.sh
set -euo pipefail

BRANCH="${BRANCH:-main}"
APP="legacy-x-api"

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "!! No .env here (copy ENVIRONMENT.example to .env and fill it in first)." >&2; exit 1; }
PORT="${PORT:-$(sed -n 's/^PORT=//p' .env | tail -n1)}"
PORT="${PORT:-3000}"

echo "==> Node $(node -v)"

# Discord: the subjects of the commits this deploy brought, as written (legacyxxx-plugins/scripts/announce.sh
# on this VPS; it posts nothing without a webhook and never fails the deploy).
announce() {
  local script="${ANNOUNCE:-/opt/legacyxxx-plugins/scripts/announce.sh}" to
  [[ -f "$script" ]] || return 0
  to="$(git rev-parse HEAD)"
  bash "$script" --title "API updated" --commits "$(pwd)" "$FROM" "$to" \
    --footer "legacyxxx-backend $(git rev-parse --short "$FROM") → $(git rev-parse --short "$to")" || true
}

FROM="$(git rev-parse HEAD)"
echo "==> Pulling $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> Installing dependencies"
npm ci

echo "==> Typecheck and build"
npm run check
npm run build

echo "==> Reloading pm2 ($APP)"
if pm2 describe "$APP" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --env production --update-env
else
  pm2 start ecosystem.config.cjs --env production
fi
pm2 save >/dev/null

echo "==> Health check on 127.0.0.1:$PORT"
for attempt in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "==> Done: $(git log -1 --format='%h %s') (healthy)"
    announce
    exit 0
  fi
  sleep 1
done
echo "!! The API did not answer /health within 15 s. Check: pm2 logs $APP --lines 50" >&2
exit 1
