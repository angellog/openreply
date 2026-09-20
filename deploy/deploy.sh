#!/usr/bin/env bash
#
# Deploy or update OpenReply in place.
#
# Pulls, installs, migrates, builds, and restarts both services. Run as the
# service user (provision.sh does this for you on first run):
#
#   sudo -u openreply /srv/openreply/deploy/deploy.sh
#
# The build happens before anything is restarted, so a build that fails leaves
# the currently-running version untouched.
#
set -euo pipefail

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

SKIP_PULL=0
[[ "${1:-}" == "--skip-pull" ]] && SKIP_PULL=1

CONFIG_FILE=/etc/openreply/deploy.conf
ENV_FILE=/etc/openreply/openreply.env
[[ -f "$CONFIG_FILE" ]] || die "$CONFIG_FILE not found — run provision.sh first."

# shellcheck source=/dev/null
source "$CONFIG_FILE"
: "${APP_DIR:?}" "${REPO_BRANCH:?}"

cd "$APP_DIR"

if (( ! SKIP_PULL )); then
  log "Fetching $REPO_BRANCH"
  git fetch --quiet origin "$REPO_BRANCH"
  git checkout --quiet "$REPO_BRANCH"
  git reset --hard --quiet "origin/$REPO_BRANCH"
fi
log "At $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# `next build` needs typescript, tailwind, and the rest of devDependencies, so
# this must not be an --omit=dev install. NODE_ENV is forced to development for
# the install step alone, because npm silently skips devDependencies when it is
# already "production" in the environment.
log "Installing dependencies"
NODE_ENV=development npm ci --include=dev --no-audit --no-fund

# Migrations read DATABASE_URL, which lives in the root-owned env file. Pull in
# just that one variable rather than sourcing the whole file into this shell.
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")"
[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is not set in $ENV_FILE"
export DATABASE_URL

log "Applying database migrations"
npx prisma migrate deploy

log "Building"
NODE_ENV=production npm run build

log "Restarting services"
# The service user is granted exactly these two restarts via sudoers (see
# provision.sh), so a deploy never needs broader root.
sudo -n systemctl restart openreply-web.service openreply-worker.service

sleep 3
for unit in openreply-web openreply-worker; do
  state="$(systemctl is-active "$unit.service" || true)"
  printf '  %-18s %s\n' "$unit" "$state"
  [[ "$state" == active ]] || die "$unit failed to start — journalctl -u $unit -n 50"
done

log "Deployed."
