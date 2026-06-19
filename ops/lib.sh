#!/usr/bin/env bash
# Shared config + helpers for the daemon ops scripts. Source, do not execute.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="t3code.service"
PORT="3773"

# systemctl for the user instance
uctl() { systemctl --user "$@"; }

daemon_is_active() {
  [ "$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)" = "active" ]
}

require_systemd_unit() {
  if ! systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
    echo "error: $SERVICE not found for the user systemd instance." >&2
    exit 1
  fi
}

# wait_for_http <url> <timeout_seconds> — poll until the URL responds (or timeout)
wait_for_http() {
  local url="$1" timeout="${2:-30}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -sf --max-time 5 -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}
