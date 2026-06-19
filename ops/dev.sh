#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_systemd_unit

if daemon_is_active; then
  echo "==> Stopping $SERVICE for dev session (frees ~/.t3) …"
  uctl stop "$SERVICE"
else
  echo "==> $SERVICE already stopped."
fi

on_exit() {
  echo
  echo "==> Dev session ended. Daemon left STOPPED."
  echo "    Next steps:"
  echo "      pnpm daemon:deploy  # build your changes + serve on :$PORT"
  echo "      pnpm daemon:start  # restore the previously deployed build (no rebuild)"
}
trap on_exit EXIT

cd "$REPO_DIR"
echo "==> Starting full dev stack (web HMR + server watch) against ~/.t3 …"
echo "    web: http://localhost:5733   api: http://localhost:13773"
pnpm dev
