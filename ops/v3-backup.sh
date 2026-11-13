#!/usr/bin/env bash
# LEGACY-X v3.0: a nightly ENCRYPTED backup of everything the web VPS holds that is not in Git or Supabase:
# the .env files (API and bot), the bot's state (data/), Nginx sites and snippets, the pm2 list, /etc/legacyx, the crontab.
# The old env-backup.sh kept its copies on the same VPS, so they died with it (2026-11): these go OFF the VPS too.
#
#   sudo bash ops/v3-backup.sh run          back up now (cron does it at 04:30)
#   sudo bash ops/v3-backup.sh setup-remote user@host:/folder    set the off-VPS copy: makes an SSH key, prints its public half to authorize there
#   sudo bash ops/v3-backup.sh list         what is kept here
#   sudo bash ops/v3-backup.sh bundle       path of the newest bundle: copy it to your own PC (scp) now and then
#   sudo bash ops/v3-backup.sh restore <file.tar.enc> [target-dir]   decrypt and unpack (default target /tmp/legacyx-restore)
#
# The passphrase is /etc/legacyx/backup.pass (made on first run). COPY IT TO A PASSWORD MANAGER OFF THIS VPS: without it a backup cannot be opened,
# and a backup next to its passphrase on a dead VPS is worth nothing.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/legacyx}"
DEST="${DEST:-/var/backups/legacyx}"
CONF="/etc/legacyx/backup.conf"
PASS="/etc/legacyx/backup.pass"
KEY="/etc/legacyx/backup_ed25519"
KEEP="${KEEP:-14}"
say() { printf '==> %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Run with sudo."

cmd_run() {
  umask 077
  mkdir -p "$DEST" /etc/legacyx
  chmod 700 "$DEST"
  if [[ ! -s "$PASS" ]]; then
    openssl rand -base64 36 > "$PASS"; chmod 600 "$PASS"
    say "Made $PASS. Copy it OFF this VPS (password manager) now."
  fi
  local stamp tmp files out
  stamp="$(date +%Y%m%d-%H%M%S)"; tmp="$(mktemp -d)"; out="$DEST/legacyx-$stamp.tar.enc"
  files=()
  for f in "$APP_ROOT/legacyxxx-backend/.env" "$APP_ROOT/legacyxxx-discord-bot/.env" /etc/legacyx /etc/cron.d/legacyx /etc/nginx/sites-available /etc/nginx/snippets; do
    [[ -e "$f" ]] && files+=("$f")
  done
  [[ -d "$APP_ROOT/legacyxxx-discord-bot/data" ]] && files+=("$APP_ROOT/legacyxxx-discord-bot/data")
  [[ -d /var/lib/legacyx ]] && files+=(/var/lib/legacyx)
  crontab -l -u legacyx > "$tmp/crontab-legacyx.txt" 2>/dev/null || true
  (cd /home/legacyx 2>/dev/null && ls -d .pm2/dump.pm2 >/dev/null 2>&1 && cp .pm2/dump.pm2 "$tmp/pm2-dump.json") || true
  files+=("$tmp")
  tar -czf - --exclude='etc/legacyx/backup.pass' "${files[@]}" 2>/dev/null | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASS" -out "$out"
  rm -rf "$tmp"
  say "Backup: $out ($(du -h "$out" | cut -f1))"
  ls -1t "$DEST"/legacyx-*.tar.enc | tail -n +$((KEEP + 1)) | xargs -r rm -f
  if [[ -r "$CONF" ]] && grep -q '^REMOTE=' "$CONF"; then
    local remote; remote="$(sed -n 's/^REMOTE=//p' "$CONF" | tail -n1)"
    rsync -a -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes" "$out" "$remote/" && say "Copied off the VPS to $remote" || printf '!! The off-VPS copy FAILED (%s). This backup lives only here.\n' "$remote" >&2
  else
    printf '!! No off-VPS copy is set (setup-remote). Until it is, copy the newest bundle to your PC yourself.\n' >&2
  fi
}

cmd_setup_remote() {
  local remote="${1:-}"; [[ "$remote" == *:* ]] || die "Usage: $0 setup-remote user@host:/folder"
  umask 077
  mkdir -p /etc/legacyx
  [[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N "" -C "legacyx-backup" -f "$KEY"
  printf 'REMOTE=%s\n' "$remote" > "$CONF"
  say "Add this public key to $remote's authorized_keys (the folder must exist), then run: sudo bash $0 run"
  cat "$KEY.pub"
}

cmd_list() { ls -lh "$DEST"/legacyx-*.tar.enc 2>/dev/null || echo "No backups yet."; }
cmd_bundle() { ls -1t "$DEST"/legacyx-*.tar.enc 2>/dev/null | head -1; }
cmd_restore() {
  local file="${1:-}" target="${2:-/tmp/legacyx-restore}"
  [[ -f "$file" ]] || die "Usage: $0 restore <file.tar.enc> [target-dir]"
  [[ -r "${PASS_FILE:-$PASS}" ]] || die "The passphrase file ${PASS_FILE:-$PASS} is missing: put the one from your password manager there (PASS_FILE=/path to use another)."
  mkdir -p "$target"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:${PASS_FILE:-$PASS}" -in "$file" | tar -xzf - -C "$target"
  say "Unpacked into $target (paths are kept: opt/legacyx/.../.env, etc/legacyx, etc/nginx ...). Copy back what you need."
}

case "${1:-}" in
  run) cmd_run ;;
  setup-remote) shift; cmd_setup_remote "$@" ;;
  list) cmd_list ;;
  bundle) cmd_bundle ;;
  restore) shift; cmd_restore "$@" ;;
  *) sed -n 1,16p "$0"; exit 1 ;;
esac
