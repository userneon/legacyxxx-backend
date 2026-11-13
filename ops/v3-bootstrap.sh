#!/usr/bin/env bash
# LEGACY-X v3.0: build the whole WEB VPS (website, staff site, API, Discord bot) from a bare Ubuntu 22.04/24.04 in two commands.
# Written after the web VPS expired and was deleted on 2026-11 (code and the database were safe, the server and its .env files were not).
#
#   sudo bash ops/v3-bootstrap.sh prepare     # packages, user, folders, repositories, Nginx, firewall, .env files (with a fresh JWT_SECRET)
#   ... fill the two .env files (docs/V3_REBUILD.md lists every value and where to get it) ...
#   sudo bash ops/v3-bootstrap.sh certs       # HTTPS certificates (DNS must already point at this VPS)
#   sudo bash ops/v3-bootstrap.sh finish      # build and start the API (pm2), the website, the staff site and the bot, backups and watch
#   sudo bash ops/v3-bootstrap.sh status      # what runs
#
# Settings (environment variables): DOMAIN (legacyx.cc), CERT_EMAIL, GIT_BASE (https://github.com/userneon), APP_USER (legacyx), APP_ROOT (/opt/legacyx).
# Safe to run again: it never overwrites a file you already filled in. The game servers (cs2) are a different VPS: legacyxxx-plugins/scripts/cs2-host.sh.
set -euo pipefail

DOMAIN="${DOMAIN:-legacyx.cc}"
CERT_EMAIL="${CERT_EMAIL:-}"
GIT_BASE="${GIT_BASE:-https://github.com/userneon}"
APP_USER="${APP_USER:-legacyx}"
APP_ROOT="${APP_ROOT:-/opt/legacyx}"
BACKEND="$APP_ROOT/legacyxxx-backend"
FRONTEND="$APP_ROOT/legacyxxx-frontend"
BOT="$APP_ROOT/legacyxxx-discord-bot"
PLUGINS="$APP_ROOT/legacyxxx-plugins"
CONF_DIR="/etc/legacyx"

say() { printf '==> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }
[[ $EUID -eq 0 ]] || die "Run with sudo."
as_app() { runuser -u "$APP_USER" -- "$@"; }

cmd_prepare() {
  say "Packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y git curl ca-certificates build-essential python3 rsync nginx certbot python3-certbot-nginx ufw fail2ban unattended-upgrades openssl cron
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
    say "Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  command -v pm2 >/dev/null || npm install -g pm2

  say "User and folders"
  id "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$APP_USER"
  mkdir -p "$APP_ROOT" /var/www/legacyx /var/www/legacyx-admin /var/www/legacyx-static "$CONF_DIR" /var/lib/legacyx/web
  chown -R "$APP_USER:$APP_USER" "$APP_ROOT" /var/www/legacyx /var/www/legacyx-admin /var/www/legacyx-static /var/lib/legacyx
  chmod 750 "$CONF_DIR"

  say "Repositories ($GIT_BASE)"
  for repo in legacyxxx-backend legacyxxx-frontend legacyxxx-discord-bot legacyxxx-plugins; do
    if [[ -d "$APP_ROOT/$repo/.git" ]]; then
      as_app git -C "$APP_ROOT/$repo" pull --ff-only || warn "$repo: pull failed, left as it is"
    else
      as_app git clone "$GIT_BASE/$repo.git" "$APP_ROOT/$repo" || die "Could not clone $repo. If it is private, give the VPS a read-only deploy key (docs/V3_REBUILD.md) or set GIT_BASE to a URL with a token (never commit it)."
    fi
  done

  # the deploy scripts look for announce.sh (Discord update posts) at /opt/legacyxxx-plugins
  [[ -e /opt/legacyxxx-plugins ]] || ln -s "$PLUGINS" /opt/legacyxxx-plugins

  say "Nginx snippets and sites"
  mkdir -p /etc/nginx/snippets
  cp "$FRONTEND"/ops/nginx/legacyx-frontend.conf "$FRONTEND"/ops/nginx/legacyx-admin.conf "$FRONTEND"/ops/nginx/legacyx-security-headers.conf "$FRONTEND"/ops/nginx/legacyx-static-images.conf /etc/nginx/snippets/
  write_nginx_site
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx

  say "Firewall and brute-force protection"
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  ufw --force enable >/dev/null
  systemctl enable --now fail2ban
  dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

  make_env_files
  say "Done. Next: fill $BACKEND/.env and $BOT/.env (docs/V3_REBUILD.md), point DNS at this VPS, then: sudo bash $BACKEND/ops/v3-bootstrap.sh certs"
}

write_nginx_site() {
  local site=/etc/nginx/sites-available/legacyx
  [[ -f "$site" ]] && { say "Nginx site exists, kept: $site"; return 0; }
  cat > "$site" <<NGINX
# LEGACY-X web VPS. certbot adds the HTTPS lines (sudo bash ops/v3-bootstrap.sh certs).
server {
    server_name $DOMAIN www.$DOMAIN;
    root /var/www/legacyx;
    include /etc/nginx/snippets/legacyx-frontend.conf;
    listen 80;
}
server {
    server_name admin.$DOMAIN;
    root /var/www/legacyx-admin;
    include /etc/nginx/snippets/legacyx-admin.conf;
    listen 80;
}
server {
    server_name api.$DOMAIN;
    client_max_body_size 12m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    listen 80;
}
server {
    server_name static.$DOMAIN;
    root /var/www/legacyx-static;
    include /etc/nginx/snippets/legacyx-static-images.conf;
    listen 80;
}
NGINX
  ln -sf "$site" /etc/nginx/sites-enabled/legacyx
  rm -f /etc/nginx/sites-enabled/default
}

# A random JWT_SECRET and the fixed values are written; every key that must come from a service is left as __FILL__ so `finish` refuses to start until it is set.
make_env_files() {
  local env="$BACKEND/.env" botenv="$BOT/.env" jwt
  if [[ ! -f "$env" ]]; then
    jwt="$(openssl rand -hex 32)"
    cp "$BACKEND/ENVIRONMENT.example" "$env"
    sed -i -E \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$jwt|" \
      -e "s|^SUPABASE_URL=.*|SUPABASE_URL=__FILL__|" \
      -e "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=__FILL__|" \
      -e "s|^STEAM_WEB_API_KEY=.*|STEAM_WEB_API_KEY=__FILL__|" \
      -e "s|^PUBLIC_API_ORIGIN=.*|PUBLIC_API_ORIGIN=https://api.$DOMAIN|" \
      -e "s|^STEAM_OPENID_ORIGIN=.*|STEAM_OPENID_ORIGIN=https://$DOMAIN|" \
      -e "s|^FRONTEND_ORIGIN=.*|FRONTEND_ORIGIN=https://$DOMAIN|" \
      -e "s|^AUTH_COOKIE_DOMAIN=.*|AUTH_COOKIE_DOMAIN=.$DOMAIN|" \
      -e "s|^POST_LOGIN_REDIRECT=.*|POST_LOGIN_REDIRECT=https://$DOMAIN/|" \
      -e "s|^STATIC_ASSET_BASE_URL=.*|STATIC_ASSET_BASE_URL=https://static.$DOMAIN|" "$env"
    grep -q '^ADMIN_ORIGIN=' "$env" || echo "ADMIN_ORIGIN=https://admin.$DOMAIN" >> "$env"
    chown "$APP_USER:$APP_USER" "$env"; chmod 600 "$env"
    say "Wrote $env with a NEW JWT_SECRET (every player signs in again once, that is expected)"
  else
    say "$env exists, kept"
  fi
  if [[ ! -f "$botenv" ]]; then
    cp "$BOT/.env.example" "$botenv"
    sed -i -E -e "s|^DISCORD_TOKEN=.*|DISCORD_TOKEN=__FILL__|" -e "s|^GUILD_ID=.*|GUILD_ID=__FILL__|" -e "s|^API_TOKEN=.*|API_TOKEN=__FILL__|" \
      -e "s|^SITE_URL=.*|SITE_URL=https://$DOMAIN|" -e "s|^API_URL=.*|API_URL=https://api.$DOMAIN|" "$botenv"
    chown "$APP_USER:$APP_USER" "$botenv"; chmod 600 "$botenv"
    say "Wrote $botenv"
  else
    say "$botenv exists, kept"
  fi
}

cmd_certs() {
  [[ -n "$CERT_EMAIL" ]] || die "Set CERT_EMAIL=you@example.com (Let's Encrypt writes to it before a certificate expires)."
  for host in "$DOMAIN" "www.$DOMAIN" "api.$DOMAIN" "admin.$DOMAIN" "static.$DOMAIN"; do
    getent hosts "$host" >/dev/null || die "DNS for $host does not answer yet: point it at this VPS first."
  done
  certbot --nginx --non-interactive --agree-tos -m "$CERT_EMAIL" --redirect -d "$DOMAIN" -d "www.$DOMAIN" -d "api.$DOMAIN" -d "admin.$DOMAIN" -d "static.$DOMAIN"
  systemctl reload nginx
  say "HTTPS is on, certbot renews it by itself (systemctl list-timers | grep certbot)"
}

need_filled() {
  local file="$1"
  if grep -q '__FILL__' "$file"; then
    warn "Still to fill in $file:"; grep -n '__FILL__' "$file" | sed 's/=.*/=/' >&2
    die "Fill those values first (docs/V3_REBUILD.md says where each comes from)."
  fi
}

cmd_finish() {
  need_filled "$BACKEND/.env"; need_filled "$BOT/.env"
  say "API"
  as_app bash -lc "cd '$BACKEND' && bash ops/deploy.sh"
  say "Website"
  as_app bash -lc "cd '$FRONTEND' && WEB_ROOT=/var/www/legacyx API_URL=https://api.$DOMAIN bash ops/deploy.sh"
  say "Staff site"
  as_app bash -lc "cd '$FRONTEND' && ADMIN_WEB_ROOT=/var/www/legacyx-admin API_URL=https://api.$DOMAIN bash ops/deploy-admin.sh"
  say "Discord bot"
  as_app bash -lc "cd '$BOT' && npm ci && (pm2 describe legacy-x-discord >/dev/null 2>&1 && pm2 reload ecosystem.config.cjs --update-env || pm2 start ecosystem.config.cjs) && pm2 save"
  say "pm2 on boot"
  env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null 2>&1 || warn "pm2 startup: run it by hand (pm2 startup) and run the command it prints"
  printf 'BACKEND_DIR=%s\nFRONTEND_DIR=%s\nBOT_DIR=%s\nRUN_AS=%s\n' "$BACKEND" "$FRONTEND" "$BOT" "$APP_USER" > "$CONF_DIR/web.conf"
  install_cron
  say "Done. Open https://$DOMAIN . Then: docs/V3_REBUILD.md -> 'After the first start'."
}

install_cron() {
  cat > /etc/cron.d/legacyx <<CRON
# LEGACY-X v3.0 (ops/v3-bootstrap.sh): a backup of every secret and state file each night, and a check every 10 minutes
30 4 * * * root bash $BACKEND/ops/v3-backup.sh run >> /var/log/legacyx-backup.log 2>&1
*/10 * * * * root bash $BACKEND/ops/v3-watch.sh >> /var/log/legacyx-watch.log 2>&1
CRON
  chmod 644 /etc/cron.d/legacyx
}

cmd_status() {
  as_app pm2 status || true
  systemctl is-active nginx fail2ban || true
  curl -fsS --max-time 5 http://127.0.0.1:3000/health && echo || warn "API /health does not answer"
  ufw status | head -5
}

case "${1:-}" in
  prepare) cmd_prepare ;;
  certs) cmd_certs ;;
  finish) cmd_finish ;;
  status) cmd_status ;;
  *) sed -n 1,16p "$0"; exit 1 ;;
esac
