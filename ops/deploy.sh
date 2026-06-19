#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_systemd_unit
cd "$REPO_DIR"

echo "==> Building server bundle (web + contracts + t3) …"
pnpm build:server

echo "==> Restarting $SERVICE …"
uctl restart "$SERVICE"

echo "==> Waiting for :$PORT to serve …"
if wait_for_http "http://localhost:$PORT" 45; then
  echo "==> Deployed: $SERVICE serving fresh build on :$PORT"
else
  echo "error: $SERVICE did not serve on :$PORT within 45s; check 'pnpm daemon:logs'." >&2
  exit 1
fi
