#!/usr/bin/env bash
#
# Watchdog for the two long-running services.
#
# systemd already restarts a process that exits. What it cannot see is a process
# that is still alive but wedged — an event loop blocked, a connection pool
# exhausted, a worker that stopped consuming. This checks for actual liveness
# and restarts only the component that is genuinely stuck.
#
# Deliberately narrow: the web check restarts on *no response at all*, never on
# a 503. /api/health reports 503 whenever the worker is down, and restarting the
# web app because the worker died would be the wrong service and would mask the
# real fault.
#
set -euo pipefail

# OPENREPLY_ETC exists so this can be exercised against a non-production
# checkout. systemd never sets it, so the units always read /etc/openreply.
ETC="${OPENREPLY_ETC:-/etc/openreply}"
CONFIG_FILE="$ETC/deploy.conf"
# shellcheck source=/dev/null
source "$CONFIG_FILE"
: "${APP_PORT:=3000}"

HEALTH_URL="http://127.0.0.1:${APP_PORT}/api/health"

log() { printf '%s\n' "$*"; }

# ─── Web: is it answering HTTP at all? ──────────────────────────────────────

responds() {
  curl --silent --output /dev/null --max-time 10 "$HEALTH_URL"
}

if responds; then
  web_ok=1
else
  # One transient failure during a deploy or a GC pause is not an outage.
  # Confirm before acting.
  sleep 15
  responds && web_ok=1 || web_ok=0
fi

if (( ! web_ok )); then
  log "web: no HTTP response after two attempts — restarting openreply-web"
  systemctl restart openreply-web.service
  exit 0
fi

# ─── Worker: is the heartbeat fresh? ────────────────────────────────────────

# The worker writes a heartbeat to Redis every 30s with a 120s TTL, so a missing
# key means it has not checked in for at least two minutes. That is the only
# reliable signal that it is wedged rather than merely idle — an idle worker
# still heartbeats.
if ! redis-cli --raw EXISTS health:worker:dm 2>/dev/null | grep -q '^1$'; then
  if ! systemctl is-active --quiet openreply-worker.service; then
    log "worker: not running — starting openreply-worker"
    systemctl start openreply-worker.service
  else
    log "worker: process alive but heartbeat stale — restarting openreply-worker"
    systemctl restart openreply-worker.service
  fi
  exit 0
fi

# ─── Report degraded state without acting on it ─────────────────────────────

status="$(curl --silent --max-time 10 "$HEALTH_URL" | jq -r '.status' 2>/dev/null || echo unknown)"
[[ "$status" == ok ]] || log "health: reporting \"$status\" (both services up; see /diagnostics)"
