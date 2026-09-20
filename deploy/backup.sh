#!/usr/bin/env bash
#
# Nightly Postgres dump.
#
# Everything that cannot be rebuilt lives in Postgres: connected accounts and
# their encrypted tokens, targets, DM logs, and tracked-link clicks. Redis holds
# only the queue, which is transient by design and needs no backup.
#
# The dumps are useless without ENCRYPTION_KEY — Instagram tokens are encrypted
# with it, so restoring a dump onto an instance with a different key leaves every
# account unable to send. The env file is backed up alongside for that reason.
#
set -euo pipefail

# OPENREPLY_ETC exists so this can be exercised against a non-production
# checkout. systemd never sets it, so the units always read /etc/openreply.
ETC="${OPENREPLY_ETC:-/etc/openreply}"
CONFIG_FILE="$ETC/deploy.conf"
ENV_FILE="$ETC/openreply.env"

# shellcheck source=/dev/null
source "$CONFIG_FILE"
: "${DB_NAME:?}" "${BACKUP_DIR:=/var/backups/openreply}" "${BACKUP_KEEP_DAYS:=14}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$BACKUP_DIR/openreply-$stamp.sql.gz"

DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")"
[[ -n "$DATABASE_URL" ]] || { echo "DATABASE_URL missing from $ENV_FILE" >&2; exit 1; }

# Write to a temp name and rename only on success, so an interrupted dump can
# never be mistaken for a good one by the retention sweep below.
pg_dump --dbname="$DATABASE_URL" --no-owner --no-privileges \
  | gzip -9 > "$dump.partial"
mv "$dump.partial" "$dump"
chmod 600 "$dump"

# Keep a copy of the env file next to the dumps. Same directory, same 0600.
install -m 600 "$ENV_FILE" "$BACKUP_DIR/openreply.env.snapshot"

find "$BACKUP_DIR" -name 'openreply-*.sql.gz' -mtime "+$BACKUP_KEEP_DAYS" -delete
find "$BACKUP_DIR" -name '*.partial' -mtime +1 -delete

size="$(du -h "$dump" | cut -f1)"
count="$(find "$BACKUP_DIR" -name 'openreply-*.sql.gz' | wc -l | tr -d ' ')"
echo "backup: $dump ($size); $count kept"

# A backup that only ever lives on the machine it is backing up is not a backup.
# Copy $BACKUP_DIR off-box on a schedule — see deploy/README.md.
