# Local daemon: build / deploy / dev workflow

**Date:** 2026-06-17
**Status:** Approved (design)

## Problem

A downloaded build of T3 Code runs as a persistent systemd **user** service
(`t3code.service`) serving the web UI on `:3773`. That service currently runs a
**globally npm-installed** copy of the `t3` package
(`~/.nvm/versions/node/v24.16.0/lib/node_modules/t3/dist/bin.mjs`), which is
disconnected from this source checkout at `/home/chaz/projects/t3code`.

The operator wants to customize this source and iterate, which requires:

1. An easy way to **build from source and deploy** the result into the persistent
   daemon.
2. An easy way to **run a dev server** (with live reload) so changes are visible
   while editing — which means stopping the persistent daemon for the dev session
   and bringing it back afterward.
3. A way to **redeploy** the persistent daemon once a set of changes is complete.

## Current-state facts (verified)

- **Service:** `~/.config/systemd/user/t3code.service`, `Type=simple`,
  `WorkingDirectory=/home/chaz`, `Restart=on-failure`. Its `Environment=PATH=…`
  intentionally includes the node23 bin dir so the `claude` harness resolves; its
  `HOME=/home/chaz`. Current `ExecStart`:
  ```
  /home/chaz/.nvm/versions/node/v24.16.0/bin/node \
    /home/chaz/.nvm/versions/node/v24.16.0/lib/node_modules/t3/dist/bin.mjs \
    serve --mode web --host 0.0.0.0 --port 3773 --no-browser
  ```
- **Package identity:** `apps/server` is the npm package named `t3` (bin `t3` →
  `./dist/bin.mjs`), version `0.0.27` — identical to the global install's version.
- **Build:** `pnpm build` runs `vp pack`, bundling `apps/server/src/bin.ts` →
  `apps/server/dist/`. The server build `dependsOn ["@t3tools/web#build"]`, so the
  web UI is built and bundled as part of the server build. The scoped command
  `vp run --filter t3 build` produces the same `apps/server/dist/` artifact while
  building only what the server needs (web + contracts), not the whole monorepo
  (mobile/desktop/marketing).
- **Runtime deps:** `vp pack` bundles `@t3tools/*` and a few others; native /
  heavy deps (`node-pty`, sqlite client, `@anthropic-ai/claude-agent-sdk`) are
  **not** bundled and are resolved from `node_modules` at runtime. Running the
  built `apps/server/dist/bin.mjs` from inside the repo resolves these from the
  repo's existing `node_modules` — the same resolution `pnpm dev` already relies
  on.
- **Dev mode:** `pnpm dev` runs the web app with HMR (base port `5733`) and the
  server in watch mode (`node --watch src/bin.ts`, base port `13773`) in parallel.
  These ports differ from the daemon's `:3773`, but dev and the daemon both use
  the same state home `~/.t3`, so they must not run simultaneously.

## Decisions

1. **Deploy model — daemon runs the repo's built artifact.** Rewrite the unit's
   `ExecStart` to run `/home/chaz/projects/t3code/apps/server/dist/bin.mjs`.
   "Deploy" then means: build → restart the service. No file copy into the global
   install. All other unit fields (env, working dir, flags) are preserved exactly.
2. **Dev state — shared `~/.t3` (real data).** The dev server reads/writes the
   same state as the daemon so the operator can iterate against real threads
   (e.g. to reproduce the context-window meter behavior). The daemon is therefore
   stopped for the duration of a dev session.
3. **Dev stack — full stack with HMR.** Dev sessions run `pnpm dev` (web HMR +
   server watch).
4. **Dev-session exit behavior — leave the daemon stopped (option B).** When a dev
   session ends, edits are not yet built into `dist`. Rather than silently
   restarting the daemon on the old build (which invites "I edited code but the
   daemon shows old behavior" confusion), `daemon:dev` leaves the service stopped
   and prints the next-step commands. The operator explicitly chooses to either
   `pnpm daemon:deploy` (build new code + serve) or `pnpm daemon:start` (restore the
   previously deployed build without building).

## Design

### One-time setup

Edit `~/.config/systemd/user/t3code.service`, changing only the `ExecStart`
binary path to the repo artifact:

```
ExecStart=/home/chaz/.nvm/versions/node/v24.16.0/bin/node \
  /home/chaz/projects/t3code/apps/server/dist/bin.mjs \
  serve --mode web --host 0.0.0.0 --port 3773 --no-browser
```

Then `systemctl --user daemon-reload`. Build the artifact at least once
(`pnpm daemon:deploy`) so `apps/server/dist/bin.mjs` exists before the next start. The
unused global `node_modules/t3` install is left in place.

### Scripts

Plain `bash` scripts under `ops/` (kept out of the TypeScript `scripts/`
workspace package), fronted by `package.json` scripts for discoverability. A
shared `ops/lib.sh` holds the service name, repo path, and helpers.

| Command               | Script                  | Behavior                                                                                                                                                    |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm daemon:deploy`  | `ops/deploy.sh`         | `set -euo pipefail`; `vp run --filter t3 build`; on success `systemctl --user restart t3code.service`; print status. Build failure aborts before restart.   |
| `pnpm daemon:dev`     | `ops/dev.sh`            | Stop the service; run `pnpm dev` (foreground); on exit leave the service stopped and print next-step commands (`pnpm daemon:deploy` / `pnpm daemon:start`). |
| `pnpm daemon:start`   | `ops/daemon.sh start`   | `systemctl --user start` (restore last-deployed build, no rebuild).                                                                                         |
| `pnpm daemon:stop`    | `ops/daemon.sh stop`    | `systemctl --user stop`.                                                                                                                                    |
| `pnpm daemon:restart` | `ops/daemon.sh restart` | `systemctl --user restart`.                                                                                                                                 |
| `pnpm daemon:status`  | `ops/daemon.sh status`  | `is-active` + resolved `ExecStart` + whether `:3773` is listening.                                                                                          |
| `pnpm daemon:logs`    | `ops/daemon.sh logs`    | `journalctl --user -u t3code.service -f`.                                                                                                                   |

### Typical loop

```
pnpm daemon:dev        # stops daemon; web HMR :5733 + server :13773 against ~/.t3
# …edit, observe live…
Ctrl-C                 # session ends; daemon left stopped; next steps printed
pnpm deploy            # build apps/server/dist + restart daemon on :3773
```

## Error handling / edge cases

- **Build failure during deploy:** `set -e` stops before the restart, so a running
  daemon keeps serving its in-memory build. Note: `vp pack` uses `clean: true`, so
  a failed build may leave `apps/server/dist` partially written; the next explicit
  start/deploy rebuilds it. Acceptable for a single-operator workflow.
- **Daemon already stopped when `daemon:dev` starts:** detect with
  `systemctl --user is-active`; do not error.
- **Port/state contention:** `daemon:dev` always stops the service first, so the
  daemon and dev server never share `~/.t3` concurrently.

## Out of scope

- Building/deploying the desktop, mobile, marketing, or cloud apps.
- Isolated/sandboxed dev state (explicitly chose shared `~/.t3`).
- Reverting to or maintaining the global npm install.

## Verification

- After one-time setup: `systemctl --user show t3code.service -p ExecStart`
  reflects the repo path; `pnpm daemon:deploy` builds and the service comes up active;
  `curl -sf http://localhost:3773` (or the UI) responds.
- `pnpm daemon:dev` stops the service, serves the dev UI on `:5733`, and on exit
  leaves the service inactive with next-step output.
