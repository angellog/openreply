#!/usr/bin/env bash
#
# Point this instance at a (new) domain.
#
# The hostname appears in four places that must agree, or things fail in ways
# that are hard to trace: Caddy's certificate, NEXTAUTH_URL (which builds the
# OAuth redirect, tracked links, and login callbacks), and the two URLs
# registered in the Meta app. This updates the first two and prints the two you
# must paste into Meta yourself.
#
# Usage:  sudo /srv/openreply/deploy/set-domain.sh openreply.yourdomain.com
#
set -euo pipefail

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this as root."

NEW_DOMAIN="${1:-}"
[[ -n "$NEW_DOMAIN" ]] || die "Usage: set-domain.sh <hostname>"
[[ "$NEW_DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]] \
  || die "\"$NEW_DOMAIN\" is not a valid hostname."

CONFIG_FILE=/etc/openreply/deploy.conf
ENV_FILE=/etc/openreply/openreply.env
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$CONFIG_FILE"
OLD_DOMAIN="$DOMAIN"

# DNS has to resolve here before Caddy can complete the ACME challenge. Warn
# rather than refuse — the record may simply not have propagated to this box yet.
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')"
RESOLVED="$(getent hosts "$NEW_DOMAIN" | awk '{print $1}' | head -n1 || true)"
if [[ -z "$RESOLVED" ]]; then
  printf '\033[1;33m[warn]\033[0m %s does not resolve yet. Caddy will keep retrying the certificate until it does.\n' "$NEW_DOMAIN"
elif [[ -n "$SERVER_IP" && "$RESOLVED" != "$SERVER_IP" ]]; then
  printf '\033[1;33m[warn]\033[0m %s resolves to %s but this server is %s. The certificate will fail until the A record is corrected.\n' \
    "$NEW_DOMAIN" "$RESOLVED" "$SERVER_IP"
fi

log "Updating $CONFIG_FILE"
sed -i "s|^DOMAIN=.*|DOMAIN=$NEW_DOMAIN|" "$CONFIG_FILE"

log "Updating NEXTAUTH_URL"
sed -i "s|^NEXTAUTH_URL=.*|NEXTAUTH_URL=https://$NEW_DOMAIN|" "$ENV_FILE"
# Only rewrite the sender if it still points at the old host; a real Resend
# domain set by hand must not be clobbered.
sed -i "s|@$OLD_DOMAIN>|@$NEW_DOMAIN>|" "$ENV_FILE"

log "Rewriting the Caddy configuration"
sed -e "s|@@DOMAIN@@|$NEW_DOMAIN|g" \
    -e "s|@@APP_PORT@@|${APP_PORT:-3000}|g" \
    -e "s|@@ACME_EMAIL@@|${ACME_EMAIL:-}|g" \
    "$SCRIPT_DIR/Caddyfile" > /etc/caddy/Caddyfile
# validate loads the config, which includes opening the log writer.
mkdir -p /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
  || die "Generated Caddyfile is invalid; nothing was reloaded."

systemctl reload caddy
# NEXTAUTH_URL is read at boot, so the app has to come back for the new host to
# take effect anywhere it builds a URL.
systemctl restart openreply-web.service openreply-worker.service

cat <<EOF

$(printf '\033[1;32m')Now serving https://$NEW_DOMAIN$(printf '\033[0m')

Caddy issues the certificate on the first request once DNS resolves here.
Watch it with:  journalctl -u caddy -f

Update these two in your Meta app — they must match character for character:

  OAuth redirect URI   https://$NEW_DOMAIN/api/instagram/callback
  Webhook callback     https://$NEW_DOMAIN/api/webhook

The Setup Console's Meta tab now shows these values, along with the verify
token and the deauthorize and data-deletion URLs.
EOF
