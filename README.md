> [!CAUTION]
> **🚧 This is a vibed-up slop experiment — NOT fit for production of any kind. 🚧**
>
> This repository is a **personal fork** that has been vibe-coded hard: features were bolted
> on by AI agents at high velocity, with minimal human review, no stability guarantees, and
> no intention of ever being a maintained product. Expect bugs, half-baked abstractions, and
> things that break without warning. **Do not run this anywhere that matters.**
>
> **Want the real thing? Fork the original — [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) — NOT this fork.**
>
> The sole purpose of this fork is to **generate a spec documenting the behavior** of what was
> built here. Treat everything in this repo as throwaway experimental scaffolding for that goal.

# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, Cursor, and OpenCode, more coming soon).

## Features added in this fork

Everything below was added on top of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code)
after forking on 2026-06-16 (~213 commits), summarized from the git history. None of it is
upstream, reviewed, or supported.

- **Unattended runs** — a wrap/clear/continue automation loop that lets a session run
  autonomously across context-clear iterations, driven by a `<<WRAP_COMPLETE>>` sentinel, with
  a ~35% context wrap-budget ceiling, auto-pause when the agent asks for input, a start
  dialog / banner / controls in the web UI, and rehydration of active runs on startup.
- **Subagent session tree** — subagents (nested, at any depth) surfaced as watchable sidebar
  sessions: DB classification columns + migrations, `getSubagentTree` / `getSubagentActivities`
  projection queries, `subscribeSubagentTree` / `subscribeSubagent` WS streams, a recursive
  sidebar tree with iteration grouping, and a read-only subagent watch route.
- **Subagent live activity in the work log** — forwarded subagent output nested under its
  parent task as contained, auto-tailing cards (gated behind `T3CODE_FORWARD_SUBAGENT_ACTIVITY`),
  with subagent `task.*` noise suppressed from the inline log.
- **`spawn_agent` MCP tool** — a cross-provider subagent tool that persists each spawned agent
  as a hidden child thread and wires it into the subagent watch tree.
- **`context_usage` MCP tool** — reports live context-window consumption to the agent.
- **Workflow-tool subagent visibility** — parses Workflow `tool_result` launch text and watches
  Workflow-spawned subagents so they appear in the tree instead of running invisibly.
- **Session background-work liveness** — a `BackgroundWorkLedger` fed from native task lifecycle
  events keeps sessions alive while background work is pending (so the idle reaper doesn't kill
  them mid-task), surfaced as a cyan "Background" pill and an in-view banner with a wait timer.
- **VS Code extension** (`@t3tools/vscode-extension`) — an embedded-server supervisor (fd-3
  handshake, backoff restart), a live chat sidebar webview, external-URL resolution via
  `asExternalUri`, and a bundled server shipped inside the VSIX.
- **Context-clear visibility** — inline "context cleared" markers at each unattended clear and
  at provider `/clear` + `/new`, with the subagent tree rebased onto the current context.
- **Daemon ops workflow** — build / deploy / dev scripts for running T3 Code as a persistent
  background daemon.
- **Personal-fork branding** — a Tokyo Night Deep dark theme and a host-label chip.
- **Provider & reliability fixes** — Claude resume-cursor and capability-probe hardening,
  checkpoint turn-diff capture across all providers (not just Codex), clearer "working directory
  no longer exists" errors, and several subagent background-status correctness fixes.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
