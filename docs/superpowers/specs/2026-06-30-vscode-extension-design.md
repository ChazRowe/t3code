# VSCode Extension — Design

**Date:** 2026-06-30
**Status:** Approved (design); pending implementation plan

## Summary

Add a new `apps/vscode` workspace package — a VSCode extension that embeds the
existing T3 Code experience by **reusing the server (`@t3tools/server`),
contracts (`@t3tools/contracts`), and client transport (`@t3tools/client-runtime`)
unchanged**, while presenting a redesigned UI built from the existing
`apps/web` React components, re-themed to VSCode theme tokens and re-laid-out
across a handful of VSCode webviews.

The extension is the third shell over the same backend (after `apps/web` and
`apps/desktop`). It follows the desktop app's proven embedding model — spawn the
server as a child process and talk to it over a loopback WebSocket — adapted so
it also works transparently under **VSCode Remote Development** (Remote-SSH/WSL/
Dev Containers).

Non-goals for v1: cloud auth (Clerk), Tailscale/relay/remote-access networking,
auto-update, the Electron `<webview>` preview/Playwright subsystem, and
browser-based VSCode (vscode.dev / code-server-in-browser).

## Goals

- Run the full session experience (chat, looping/unattended runs, subagent tree,
  settings) inside VSCode, scoped to the single workspace folder VSCode is open
  in.
- Reuse existing React components wherever useful; inherit styling from the
  active VSCode theme.
- Delegate to VSCode's native UI anything VSCode already does as well or better;
  keep a custom webview only where it adds something VSCode can't.
- Work both locally and under Remote-SSH (Windows local client → Linux remote
  host), riding VSCode's existing SSH tunnel — no extra firewall ports.

## Architecture

### Package layout

New workspace package `apps/vscode`, name `@t3tools/vscode-extension`, picked up
automatically by the `apps/*` glob in `pnpm-workspace.yaml`.

Two build targets, mirroring `apps/desktop`'s main/renderer split:

- **Extension host** (Node, CJS via esbuild/tsdown): activation, webview
  registration, server lifecycle supervision, the native bridge, and the
  cross-webview selection broker.
- **Webview bundle(s)** (browser, Vite — same toolchain as `apps/web`): the
  React UI for each webview surface.

Dependencies (workspace): `@t3tools/contracts`, `@t3tools/client-runtime`,
`@t3tools/shared`, and the reused UI components from `@t3tools/web`. The
extension spawns the already-built `@t3tools/server` bin
(`apps/server/dist/bin.mjs`); it does **not** depend on `@t3tools/desktop`.

`extensionKind` is declared as `["workspace"]` so that under Remote Development
the extension host and the spawned server both run on the **remote host**
alongside the workspace files (terminals, git, file I/O). This is why the
extension is reinstalled on the remote host — expected VSCode behavior for
workspace extensions.

### Server lifecycle

The extension host spawns `@t3tools/server` as a child process on a loopback
port, reusing the supervisor logic from `apps/desktop/src/backend/*`:

- Free-port scan (default 3773 upward), bind `127.0.0.1`.
- Readiness polling against `/.well-known/t3/environment`.
- Exponential-backoff auto-restart on crash; graceful SIGTERM shutdown.
- Bootstrap handshake (port, host, t3Home, a random local bootstrap token) piped
  to the child over fd 3 — the local-only auth path, no Clerk.

The Electron-specific spawn details (`process.execPath`,
`ELECTRON_RUN_AS_NODE=1`) are replaced with a plain Node entry point; the rest of
the supervisor is shell-agnostic and carries over.

### Transport (local + remote)

The data plane stays a **direct WebSocket from each webview to the server** via
`@t3tools/client-runtime`, unchanged. The only adaptation is how the URL is
resolved:

- The extension host resolves the server's base URL through
  `vscode.env.asExternalUri(http://127.0.0.1:<port>)`.
- **Locally** this returns the same loopback URL.
- **Under Remote-SSH** it auto-forwards the remote port to the local client over
  VSCode's existing SSH tunnel and returns a URL the (locally-rendered) webview
  can reach. WebSocket upgrade is tunneled over the same forwarded TCP port.
- The resolved ws/http base URL and the local auth ticket are passed to each
  webview at construction; the webview's CSP `connect-src` is built to include
  that origin.

This gives **one code path for local and remote**. It covers all desktop VSCode
clients (local, Remote-SSH, WSL, Dev Containers) and rides the existing SSH
connection, so it needs no firewall changes beyond the SSH port already exposed.

It does **not** cover browser-based VSCode (vscode.dev / code-server-in-browser),
where forwarding into a sandboxed browser webview is unreliable. That is an
explicit non-goal. The transport is consumed only through the existing
`EnvironmentApi`/`LocalApi` interfaces (`packages/contracts/src/ipc.ts`), so a
`postMessage`-bridged transport implementation can be added later for browser
support without touching the UI.

### Webview surfaces

Four webviews, all rendering reused `apps/web` React components re-themed to
VSCode tokens:

| #   | Surface                      | Location                              | Content                                                                                                                                                                        |
| --- | ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Session list + subagent tree | Sidebar (activity-bar view container) | Threads for the current workspace folder only; subagent tree of the selected session.                                                                                          |
| 2   | Live session chat            | Sidebar (docked)                      | The chat/conversation view (`ChatView`), including the changed-files / diff tree.                                                                                              |
| 3   | Settings                     | Editor tab (webview panel)            | The settings route with its existing internal settings-type sidebar.                                                                                                           |
| 4   | Comment-able diff            | Editor area (webview panel)           | Opened when a file in the diff tree (surface 2) is clicked. Custom — kept instead of VSCode's native diff editor specifically because it supports inline comments on the diff. |

### Cross-webview selection broker

The Electron app held all UI in one React tree sharing one Zustand store, so
sidebar selection drove the chat via shared state. The four webviews here are
isolated documents with independent stores and WS connections, so a small
**selection broker in the extension host** coordinates them:

- Holds shared UI/navigation state: active environment, active thread, and
  open-intent events ("open this diff", "open settings").
- Broadcasts changes to all webviews over `postMessage`.
- Webviews own their own server-derived state (from their own WS connection);
  they sync only _selection/navigation_ through the broker, not data.

This is the main net-new glue versus the desktop app.

### Native bridge surface

A thin replacement for the Electron `desktopBridge`/`LocalApi` surface,
implemented over webview `postMessage` → extension host → VSCode APIs. Only what
VSCode actually needs:

| Capability                              | VSCode mapping                                        |
| --------------------------------------- | ----------------------------------------------------- |
| Secret storage (provider keys, tokens)  | `context.secrets`                                     |
| Folder / file picker                    | `window.showOpenDialog`                               |
| Theme tokens                            | webview CSS vars derived from the active VSCode theme |
| Open external URL                       | `env.openExternal`                                    |
| Open file in editor                     | `window.showTextDocument`                             |
| Open VSCode terminal                    | `window.createTerminal`                               |
| Workspace folder (single-project scope) | `workspace.workspaceFolders[0]`                       |

### Native delegation vs. custom

- **Delegated to VSCode's native UI:** interactive terminal (agent terminals →
  integrated terminals), browser/preview (→ Simple Browser / user-opened URLs;
  the Electron preview subsystem does not port), file opens (→ real editor tabs),
  and git/source-control status (→ built-in SCM view).
- **Kept as custom webview:** the comment-able diff viewer, the chat/session
  view, the session list + subagent tree, and settings.
- **Regardless of the above:** command output the agent produces still renders
  inline in the chat transcript, exactly as in `apps/web`.

### Component reuse strategy

For v1, `apps/vscode` imports the React components it needs **directly from
`@t3tools/web`** via a workspace dependency, re-themed through CSS variables
mapped to VSCode theme tokens. Desktop-only surfaces (preview/browser, native
menus, window controls, drag regions, auto-update) are feature-flagged off via a
new `isVSCode` runtime flag alongside the existing `isElectron` flag in
`apps/web/src/env.ts`. Routing uses hash history (the path already taken for
Electron, since webviews load from a non-standard origin).

Extracting a dedicated `@t3tools/web-ui` package shared by both `apps/web` and
`apps/vscode` is the right medium-term move but is **deferred** — not required
for v1, and done later only if the direct-import coupling becomes painful.

## Data flow

1. Extension activates → spawns `@t3tools/server` child on a loopback port →
   waits for readiness.
2. Extension resolves the server URL via `asExternalUri` and mints a local auth
   ticket.
3. Each webview is created with the resolved URL + ticket → opens its own WS via
   `@t3tools/client-runtime` → subscribes to shell/lifecycle/thread streams.
4. UI renders reused `apps/web` components from server-derived state.
5. Selection/navigation (pick a thread, open a diff, open settings) flows through
   the extension-host broker to the other webviews.
6. Native actions (open terminal/file, pick folder, read/write secrets) flow
   through the native bridge to VSCode APIs.

## Error handling

- **Server crash:** supervisor auto-restarts with backoff; webviews show a
  reconnecting state via `client-runtime`'s existing reconnect/resubscribe.
- **Port-forward / `asExternalUri` failure (remote):** surface a clear error in
  the webview with a retry; do not silently hang.
- **Webview disposal/reload:** webviews re-subscribe on reload; the broker
  re-broadcasts current selection to a newly (re)loaded webview.
- **Per-webview WS failure:** isolated to that webview; others keep their own
  connections.

## Testing

- **Extension host unit tests:** server supervisor (spawn/readiness/restart),
  URL resolution via a mocked `asExternalUri` (local vs. forwarded), and the
  selection broker (broadcast/replay-on-load).
- **Bridge tests:** each native-bridge method maps to the correct VSCode API
  (mocked `vscode` namespace).
- **Webview smoke:** each of the four webviews mounts and connects against a
  locally-spawned server (mirrors `apps/desktop` smoke-test approach).
- **Reused component coverage** stays in `apps/web`; `apps/vscode` tests focus on
  the new shell/glue.

## Open questions / deferred

- `@t3tools/web-ui` extraction (deferred; revisit if direct-import coupling hurts).
- `postMessage` transport implementation for browser-based VSCode (deferred;
  non-goal for v1, seam preserved via `EnvironmentApi`/`LocalApi`).
- Exact packaging/distribution (`.vsix` build, marketplace vs. internal) — out of
  scope for this design; to be covered when implementation is planned.
