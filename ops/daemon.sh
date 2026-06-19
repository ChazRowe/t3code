#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_systemd_unit
cmd="${1:-status}"

case "$cmd" in
  start)   uctl start "$SERVICE";   echo "started $SERVICE" ;;
  stop)    uctl stop "$SERVICE";    echo "stopped $SERVICE" ;;
  restart) uctl restart "$SERVICE"; echo "restarted $SERVICE" ;;
  status)
    printf 'state: %s\n' "$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)"
    printf 'ExecStart: %s\n' "$(systemctl --user show "$SERVICE" -p ExecStart --value)"
    if command -v ss >/dev/null 2>&1; then
      ss -ltn 2>/dev/null | grep -q ":$PORT " \
        && echo "port $PORT: listening" \
        || echo "port $PORT: not listening"
    fi
    ;;
  logs)    journalctl --user -u "$SERVICE" -f ;;
  *) echo "usage: daemon.sh {start|stop|restart|status|logs}" >&2; exit 2 ;;
esac
