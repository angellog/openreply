#!/usr/bin/env bash
#
# Call one of OpenReply's cron endpoints.
#
# On Vercel these are driven by vercel.json. Nothing reads that file on a VPS,
# so systemd timers call them through this script instead. Losing them is not
# cosmetic: refresh-tokens is what renews Instagram access tokens ahead of
# expiry, and if it stops running the whole instance goes quiet after roughly
# sixty days with no error anywhere.
#
# Usage:  openreply-cron refresh-tokens
#         openreply-cron attach-next-reel
#
set -euo pipefail

ENDPOINT="${1:?usage: openreply-cron <refresh-tokens|attach-next-reel>}"

# OPENREPLY_ETC exists so this can be exercised against a non-production
# checkout. systemd never sets it, so the units always read /etc/openreply.
ETC="${OPENREPLY_ETC:-/etc/openreply}"
ENV_FILE="$ETC/openreply.env"
CONFIG_FILE="$ETC/deploy.conf"

# shellcheck source=/dev/null
source "$CONFIG_FILE"
: "${APP_PORT:=3000}"

CRON_SECRET="$(sed -n 's/^CRON_SECRET=//p' "$ENV_FILE")"
if [[ -z "$CRON_SECRET" ]]; then
  # The routes fall back to NEXTAUTH_SECRET when CRON_SECRET is unset, so match
  # that rather than failing on an instance configured the older way.
  CRON_SECRET="$(sed -n 's/^NEXTAUTH_SECRET=//p' "$ENV_FILE")"
fi
[[ -n "$CRON_SECRET" ]] || { echo "No CRON_SECRET or NEXTAUTH_SECRET in $ENV_FILE" >&2; exit 1; }

# Go straight to the app on loopback rather than out through the public
# hostname: no DNS, no TLS, and it still works while Caddy is reloading or the
# certificate is being renewed.
URL="http://127.0.0.1:${APP_PORT}/api/cron/${ENDPOINT}"

# Feed the credential to curl over stdin instead of argv, so it never appears in
# `ps` output for the life of the request.
response="$(
  printf 'header = "Authorization: Bearer %s"\nurl = "%s"\n' "$CRON_SECRET" "$URL" \
    | curl --config - --silent --show-error --max-time 120 \
           --write-out '\n%{http_code}' --request GET
)" || { echo "$ENDPOINT: request failed" >&2; exit 1; }

status="$(tail -n1 <<<"$response")"
body="$(sed '$d' <<<"$response")"

if [[ "$status" != 200 ]]; then
  echo "$ENDPOINT: HTTP $status — $body" >&2
  exit 1
fi

echo "$ENDPOINT: $body"
