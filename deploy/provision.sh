#!/usr/bin/env bash
#
# One-time VPS provisioning for OpenReply.
#
# Installs Node, Postgres, Redis, and Caddy; creates the service user, database,
# and environment file; installs the systemd units and timers; and locks the
# firewall down to SSH and HTTP(S). Safe to re-run — every step checks for its
# own result first.
#
# Usage, as root on a fresh Ubuntu 22.04 or 24.04 box:
#   curl -fsSL <raw-url>/deploy/provision.sh | bash
# or, from a checkout:
#   sudo ./deploy/provision.sh
#
set -euo pipefail

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this as root (sudo ./deploy/provision.sh)."

CONFIG_DIR=/etc/openreply
CONFIG_FILE="$CONFIG_DIR/deploy.conf"
ENV_FILE="$CONFIG_DIR/openreply.env"

# Where this script lives, so we can find the units and the example config
# whether we were run from a checkout or piped from curl.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$CONFIG_DIR"
chmod 750 "$CONFIG_DIR"

if [[ -f "$CONFIG_FILE" ]]; then
  log "Using existing $CONFIG_FILE"
elif [[ -f "$SCRIPT_DIR/config.env.example" ]]; then
  log "Creating $CONFIG_FILE from the example"
  install -m 640 "$SCRIPT_DIR/config.env.example" "$CONFIG_FILE"
else
  die "No $CONFIG_FILE and no config.env.example next to this script."
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

: "${DOMAIN:?DOMAIN must be set in $CONFIG_FILE}"
: "${APP_DIR:?}" "${APP_USER:?}" "${APP_PORT:?}"
: "${DB_NAME:?}" "${DB_USER:?}" "${NODE_MAJOR:?}"

# ─── Packages ───────────────────────────────────────────────────────────────

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg git ufw ripgrep jq \
  postgresql postgresql-contrib redis-server \
  debian-keyring debian-archive-keyring apt-transport-https \
  unattended-upgrades >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v)" != v"$NODE_MAJOR"* ]]; then
  log "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v), npm $(npm -v)"

if ! command -v caddy >/dev/null; then
  log "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# ─── Swap ───────────────────────────────────────────────────────────────────

# `next build` is the memory-hungry step and will be OOM-killed on a 1–2 GB box
# without swap. Cheap insurance; the running app barely touches it.
TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( TOTAL_MB < 4096 )) && [[ ! -f /swapfile ]]; then
  log "Adding a 2G swapfile (RAM is ${TOTAL_MB}MB — builds need the headroom)"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ─── Service user and checkout ──────────────────────────────────────────────

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Creating service user $APP_USER"
  adduser --system --group --home "$APP_DIR" --shell /bin/bash "$APP_USER"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  log "Cloning $REPO_URL into $APP_DIR"
  # Clone as root: $APP_DIR's parent (/srv) is root-owned, so the service user
  # cannot create a sibling temp directory there. Ownership is fixed below.
  rm -rf "$APP_DIR.tmp"
  git clone --quiet --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR.tmp"
  # adduser --home already created $APP_DIR, so move the contents in rather
  # than trying to clone over an existing directory.
  shopt -s dotglob
  mv "$APP_DIR.tmp"/* "$APP_DIR"/
  shopt -u dotglob
  rmdir "$APP_DIR.tmp"
fi

# Always, not just after a fresh clone. The documented install does the clone
# itself (`sudo git clone ... /srv/openreply`) before running this script, which
# leaves the tree root-owned — and then the service user cannot write .next and
# the build fails with a permission error a long way from its cause.
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ─── Postgres ───────────────────────────────────────────────────────────────

systemctl enable --now postgresql

DB_PASSWORD=""
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  log "Postgres role $DB_USER already exists"
else
  DB_PASSWORD="$(openssl rand -hex 24)"
  log "Creating Postgres role and database"
  sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD'"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
fi

# ─── Redis ──────────────────────────────────────────────────────────────────

# BullMQ requires noeviction: under any other policy Redis may silently drop
# queue keys when memory is tight, which loses queued DMs with no error anywhere.
log "Configuring Redis for BullMQ (noeviction, loopback only)"
REDIS_CONF=/etc/redis/redis.conf
sed -i 's/^# *maxmemory-policy .*/maxmemory-policy noeviction/' "$REDIS_CONF"
grep -q '^maxmemory-policy' "$REDIS_CONF" || echo 'maxmemory-policy noeviction' >> "$REDIS_CONF"
sed -i 's/^bind .*/bind 127.0.0.1 ::1/' "$REDIS_CONF"
systemctl enable --now redis-server
systemctl restart redis-server

# ─── Application environment ────────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]]; then
  log "Keeping existing $ENV_FILE"
else
  log "Generating $ENV_FILE"
  [[ -n "$DB_PASSWORD" ]] || die \
    "Postgres role existed but $ENV_FILE does not, so its password is unknown.
     Reset it with:  sudo -u postgres psql -c \"ALTER ROLE $DB_USER PASSWORD 'new'\"
     then write $ENV_FILE by hand."

  umask 027
  cat > "$ENV_FILE" <<EOF
# OpenReply production environment. Owned by root, readable by $APP_USER.
# systemd loads this for both services; values here win over any .env on disk.

NODE_ENV=production
NEXTAUTH_URL=https://$DOMAIN
NEXTAUTH_SECRET=$(openssl rand -base64 32)
CRON_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
REDIS_URL=redis://127.0.0.1:6379

# Login magic links. Fill these in, or use the Setup Console's local sign-in.
RESEND_API_KEY=
EMAIL_FROM=OpenReply <login@$DOMAIN>

# From your Meta app. The Setup Console's Meta tab walks through where each lives.
META_GRAPH_API_VERSION=v25.0
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
FACEBOOK_APP_SECRET=
WEBHOOK_VERIFY_TOKEN=$(openssl rand -hex 16)

# Setup Console. Reachable only at /setup?token=<the token below>; it can write
# this file and mint sessions, so the token is the only thing protecting it.
# To close it entirely: set SETUP_CONSOLE_ENABLED=false and restart.
SETUP_CONSOLE_ENABLED=true
SETUP_CONSOLE_TOKEN=$(openssl rand -hex 32)
EOF
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

# ─── systemd units ──────────────────────────────────────────────────────────

log "Installing systemd units and timers"
# The two long-running units are templated, so changing APP_DIR, APP_USER, or
# APP_PORT in deploy.conf cannot leave systemd and Caddy disagreeing about where
# the app lives or which port it answers on.
for unit in "$SCRIPT_DIR"/systemd/*.service "$SCRIPT_DIR"/systemd/*.timer; do
  [[ -e "$unit" ]] || continue
  sed -e "s|{{APP_DIR}}|$APP_DIR|g" \
      -e "s|{{APP_USER}}|$APP_USER|g" \
      -e "s|{{APP_PORT}}|$APP_PORT|g" \
      "$unit" > "/etc/systemd/system/$(basename "$unit")"
  chmod 644 "/etc/systemd/system/$(basename "$unit")"
done

install -m 750 "$SCRIPT_DIR"/backup.sh      /usr/local/bin/openreply-backup
install -m 750 "$SCRIPT_DIR"/healthcheck.sh /usr/local/bin/openreply-healthcheck
install -m 750 "$SCRIPT_DIR"/cron-call.sh   /usr/local/bin/openreply-cron

# A deploy has to restart the two services, and nothing else. Granting exactly
# those two commands means deploy.sh never needs to run as root.
cat > /etc/sudoers.d/openreply <<EOF
$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart openreply-web.service openreply-worker.service
EOF
chmod 440 /etc/sudoers.d/openreply
visudo -cf /etc/sudoers.d/openreply >/dev/null || die "Generated sudoers file is invalid."

systemctl daemon-reload

# ─── Caddy ──────────────────────────────────────────────────────────────────

log "Writing Caddy configuration for $DOMAIN"
sed -e "s|@@DOMAIN@@|$DOMAIN|g" \
    -e "s|@@APP_PORT@@|$APP_PORT|g" \
    -e "s|@@ACME_EMAIL@@|${ACME_EMAIL:-}|g" \
    "$SCRIPT_DIR/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable caddy

# ─── Firewall and unattended upgrades ───────────────────────────────────────

log "Configuring firewall (SSH, HTTP, HTTPS only)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp   >/dev/null
ufw allow 443/tcp  >/dev/null
ufw --force enable >/dev/null

# Postgres and Redis listen on loopback only, so the firewall is a second layer
# rather than the only one keeping them off the internet.
log "Enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# ─── Build and start ────────────────────────────────────────────────────────

# Enable before the first deploy so the units survive a reboot even if the
# build below fails. Enabling only creates the boot-time symlink; deploy.sh
# does the starting.
log "Enabling services at boot"
systemctl enable openreply-web.service openreply-worker.service

log "Reloading Caddy with the new configuration"
# The log directory must exist first: `caddy validate` opens the log writer as
# part of loading the config, and fails on a missing directory.
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy 2>/dev/null || true
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
  || die "Generated Caddyfile is invalid — refusing to restart Caddy."
systemctl restart caddy

log "Running the first deploy"
sudo -u "$APP_USER" "$APP_DIR/deploy/deploy.sh" --skip-pull

log "Enabling timers"
systemctl enable --now \
  openreply-refresh-tokens.timer \
  openreply-attach-next-reel.timer \
  openreply-backup.timer \
  openreply-healthcheck.timer

SETUP_TOKEN="$(grep '^SETUP_CONSOLE_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"

cat <<EOF

$(printf '\033[1;32m')Provisioning complete.$(printf '\033[0m')

  Web      $(systemctl is-active openreply-web.service)
  Worker   $(systemctl is-active openreply-worker.service)
  Caddy    $(systemctl is-active caddy.service)

Setup Console (the token is the only thing protecting it — treat it as a password):

  https://$DOMAIN/setup?token=$SETUP_TOKEN

Next:
  1. Point $DOMAIN at this server's IP, then: sudo systemctl restart caddy
     Caddy issues the certificate automatically once DNS resolves.
     Still on the placeholder domain? Run:
       sudo $APP_DIR/deploy/set-domain.sh your.real.domain
  2. Open the Setup Console and fill in the Meta credentials and Resend key.
  3. Work through its Meta tab, then connect Instagram from the Targets tab.

Logs:
  journalctl -u openreply-web -f
  journalctl -u openreply-worker -f
EOF
