# Daemon build / deploy / dev workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator `pnpm daemon:deploy` (build from source + restart the persistent daemon) and `pnpm daemon:dev` (run the live dev stack against real data), with the systemd daemon running the repo's own built artifact.

**Architecture:** A small set of `bash` scripts under `ops/`, fronted by `package.json` scripts. A one-time edit repoints the `t3code.service` systemd user unit's `ExecStart` from the global npm install to `apps/server/dist/bin.mjs` in this repo. "Deploy" = scoped build (`vp run --filter t3 build`) + `systemctl --user restart`. "Dev" = stop the daemon, run `pnpm dev`, and on exit leave the daemon stopped with next-step hints.

**Tech Stack:** bash, systemd (user instance), pnpm, vite-plus (`vp`).

## Global Constraints

- Service unit: `t3code.service` (systemd **user** instance — always `systemctl --user`).
- Repo path: `/home/chaz/projects/t3code`.
- Node binary used by the daemon: `/home/chaz/.nvm/versions/node/v24.16.0/bin/node`.
- Daemon serve args (preserve verbatim): `serve --mode web --host 0.0.0.0 --port 3773 --no-browser`.
- Preserve all existing unit fields (`Environment=PATH=…` incl. node23 bin, `HOME`, `WorkingDirectory=/home/chaz`, `Restart`); change **only** the `ExecStart` binary path.
- Dev and daemon share state home `~/.t3` and must never run concurrently.
- Build artifact produced by `vp run --filter t3 build` → `apps/server/dist/bin.mjs`.

---

### Task 1: Shared lib + daemon control script

**Files:**

- Create: `ops/lib.sh`
- Create: `ops/daemon.sh`

**Interfaces:**

- Produces: `ops/lib.sh` exporting `REPO_DIR`, `SERVICE`, `PORT`, and functions `uctl`, `daemon_is_active`, `require_systemd_unit` (sourced by the other scripts). `ops/daemon.sh {start|stop|restart|status|logs}`.

- [ ] **Step 1: Write `ops/lib.sh`**

```bash
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
```

- [ ] **Step 2: Write `ops/daemon.sh`**

```bash
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
```

- [ ] **Step 3: Make executable**

```bash
chmod +x ops/lib.sh ops/daemon.sh
```

- [ ] **Step 4: Syntax-check both scripts**

Run: `bash -n ops/lib.sh && bash -n ops/daemon.sh && echo OK`
Expected: `OK`

- [ ] **Step 5: Run status (against the still-current global-install daemon)**

Run: `bash ops/daemon.sh status`
Expected: prints `state: active`, an `ExecStart:` line still pointing at `…/lib/node_modules/t3/dist/bin.mjs`, and `port 3773: listening`.

- [ ] **Step 6: Commit**

```bash
git add ops/lib.sh ops/daemon.sh
git commit -m "Add daemon control ops scripts (lib + daemon.sh)"
```

---

### Task 2: Deploy script + scoped build script

**Files:**

- Create: `ops/deploy.sh`
- Modify: `package.json` (add `build:server` script)

**Interfaces:**

- Consumes: `ops/lib.sh` (`REPO_DIR`, `SERVICE`, `PORT`, `uctl`, `require_systemd_unit`).
- Produces: `ops/deploy.sh` (build + restart) and `pnpm build:server` (`vp run --filter t3 build`).

- [ ] **Step 1: Add `build:server` to `package.json` scripts**

Add this line to the `"scripts"` block (next to the other `build:*` entries):

```json
    "build:server": "vp run --filter t3 build",
```

- [ ] **Step 2: Write `ops/deploy.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_systemd_unit
cd "$REPO_DIR"

echo "==> Building server bundle (web + contracts + t3) …"
pnpm build:server

echo "==> Restarting $SERVICE …"
uctl restart "$SERVICE"
sleep 1

if daemon_is_active; then
  echo "==> Deployed: $SERVICE serving fresh build on :$PORT"
else
  echo "error: $SERVICE failed to come up after deploy; check 'pnpm daemon:logs'." >&2
  exit 1
fi
```

- [ ] **Step 3: Make executable + syntax-check**

Run: `chmod +x ops/deploy.sh && bash -n ops/deploy.sh && echo OK`
Expected: `OK`

(The real build + restart is exercised in Task 5's cutover, after the unit points at the repo artifact.)

- [ ] **Step 4: Commit**

```bash
git add ops/deploy.sh package.json
git commit -m "Add deploy script and scoped build:server"
```

---

### Task 3: Dev-session script

**Files:**

- Create: `ops/dev.sh`

**Interfaces:**

- Consumes: `ops/lib.sh` (`REPO_DIR`, `SERVICE`, `PORT`, `uctl`, `daemon_is_active`, `require_systemd_unit`).
- Produces: `ops/dev.sh` — stops the daemon, runs `pnpm dev`, leaves the daemon stopped on exit.

- [ ] **Step 1: Write `ops/dev.sh`**

```bash
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
  echo "      pnpm deploy        # build your changes + serve on :$PORT"
  echo "      pnpm daemon:start  # restore the previously deployed build (no rebuild)"
}
trap on_exit EXIT

cd "$REPO_DIR"
echo "==> Starting full dev stack (web HMR + server watch) against ~/.t3 …"
echo "    web: http://localhost:5733   api: http://localhost:13773"
pnpm dev
```

- [ ] **Step 2: Make executable + syntax-check**

Run: `chmod +x ops/dev.sh && bash -n ops/dev.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add ops/dev.sh
git commit -m "Add dev-session script (stop daemon, run dev, leave stopped)"
```

---

### Task 4: Wire pnpm front-door scripts

**Files:**

- Modify: `package.json` (add `deploy` + `daemon:*` scripts)

**Interfaces:**

- Consumes: `ops/deploy.sh`, `ops/dev.sh`, `ops/daemon.sh`.
- Produces: `pnpm daemon:deploy`, `pnpm daemon:dev`, `pnpm daemon:start|stop|restart|status|logs`.

- [ ] **Step 1: Add scripts to `package.json`**

Add these lines to the `"scripts"` block:

```json
    "daemon:deploy": "ops/deploy.sh",
    "daemon:dev": "ops/dev.sh",
    "daemon:start": "ops/daemon.sh start",
    "daemon:stop": "ops/daemon.sh stop",
    "daemon:restart": "ops/daemon.sh restart",
    "daemon:status": "ops/daemon.sh status",
    "daemon:logs": "ops/daemon.sh logs",
```

- [ ] **Step 2: Verify pnpm resolves them**

Run: `pnpm daemon:status`
Expected: same output as Task 1 Step 5 (state/ExecStart/port), proving the pnpm alias and script path resolve.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Add pnpm front-door scripts for deploy and daemon control"
```

---

### Task 5: One-time cutover — point the daemon at the repo artifact

**Files:**

- Modify: `~/.config/systemd/user/t3code.service` (`ExecStart` line only)

**Interfaces:**

- Consumes: `pnpm build:server` (Task 2), `apps/server/dist/bin.mjs`.

- [ ] **Step 1: Build the repo artifact first (no downtime yet)**

Run: `pnpm build:server`
Expected: completes successfully; `apps/server/dist/bin.mjs` exists (`ls -la apps/server/dist/bin.mjs`).

- [ ] **Step 2: Smoke-test the built artifact**

Run: `/home/chaz/.nvm/versions/node/v24.16.0/bin/node apps/server/dist/bin.mjs --help`
Expected: prints CLI help and exits 0 (confirms the bundle runs and resolves its runtime deps from the repo `node_modules`).

- [ ] **Step 3: Edit the unit's `ExecStart`**

In `~/.config/systemd/user/t3code.service`, change only the binary path so the line reads:

```
ExecStart=/home/chaz/.nvm/versions/node/v24.16.0/bin/node /home/chaz/projects/t3code/apps/server/dist/bin.mjs serve --mode web --host 0.0.0.0 --port 3773 --no-browser
```

Leave every other line (the `Environment=` lines, `WorkingDirectory`, `Restart`, etc.) untouched.

- [ ] **Step 4: Reload + restart**

Run: `systemctl --user daemon-reload && systemctl --user restart t3code.service`
Expected: no error.

- [ ] **Step 5: Verify the cutover**

Run: `pnpm daemon:status`
Expected: `state: active`; `ExecStart:` now shows `/home/chaz/projects/t3code/apps/server/dist/bin.mjs …`; `port 3773: listening`.

Run: `curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:3773`
Expected: a `2xx`/`3xx` HTTP status (UI responds).

- [ ] **Step 6: End-to-end verify the deploy verb**

Run: `pnpm daemon:deploy`
Expected: builds, restarts, prints `Deployed: t3code.service serving fresh build on :3773`; `pnpm daemon:status` still active.

(No commit — the systemd unit lives outside the repo. Record the new `ExecStart` in the spec doc, which already documents it.)

---

## Self-Review

- **Spec coverage:** deploy model (Task 5 cutover + Task 2 deploy) ✓; shared `~/.t3` dev (Task 3, no `T3_HOME` override) ✓; full HMR stack (Task 3 `pnpm dev`) ✓; leave-stopped-on-exit (Task 3 `on_exit`) ✓; daemon control + status/logs (Task 1) ✓; discoverable pnpm front door (Task 4) ✓; scoped build (Task 2 `build:server`) ✓.
- **Placeholder scan:** none — all scripts are complete.
- **Type/name consistency:** `SERVICE`, `PORT`, `REPO_DIR`, `uctl`, `daemon_is_active`, `require_systemd_unit` defined in `ops/lib.sh` (Task 1) and used consistently in Tasks 2–4. `build:server` defined in Task 2, consumed in Task 5.
