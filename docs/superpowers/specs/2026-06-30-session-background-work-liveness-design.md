# Design: Keep sessions "live" while background work is pending

- **Date:** 2026-06-30
- **Status:** Approved (pre-implementation)
- **Topic:** When an agent launches non-blocking work (a Workflow, a `spawn_agent`
  subagent, a backgrounded Task subagent, or a backgrounded Bash shell) and then ends
  its turn, the session must keep signalling that it is alive — a pulsing activity
  light in the session list and an in-view indicator — until **all** pending
  background operations complete. It must also remain protected from the idle reaper.

## Problem

When a turn ends (`turn.completed`), `ProviderRuntimeIngestion` transitions the
session `running → ready` and the projector settles the latest turn to `completed`
(`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1470-1552`,
`apps/server/src/orchestration/projector.ts:447-508`). The sidebar pulses its
activity light **only** when `session.status === "running"`
(`apps/web/src/components/Sidebar.logic.ts:361`), so the moment the agent ends its
turn the light goes out and the row reads "Completed" — even though background work
is still in flight and will inject a synthetic turn later
(`ClaudeAdapter.ts:3149-3189`).

There is partial infrastructure today: `hasPendingBackgroundWork(threadId)` exists on
the provider adapter (Claude returns `workflowWatchers.size > 0`,
`ClaudeAdapter.ts:4606-4612`) but it is consumed **only** by the idle reaper
(`ProviderSessionReaper.ts:110-120`) and never reaches the status model or the UI.
It also covers **only** Workflows — not `spawn_agent` subagents, backgrounded Task
subagents, or backgrounded Bash.

## Goals

1. A session with pending background work keeps a **pulsing** activity light in the
   session list, visually **distinct** from an active turn ("Working").
2. The open session view shows an indicator (like the working indicator) that the
   agent is **idle pending background completion**, including a **timer** of how long
   it has been waiting (a multi-hour reading signals a probably-lost completion event
   the user can interrupt).
3. The session is **not reaped** while background work is pending, for **all** four
   background-work sources.
4. The light goes out (row returns to "Completed") only when **all** pending
   background operations have completed.

## Non-goals

- Changing turn-settling semantics. The turn still settles to `completed` at
  `turn.completed`; we do **not** hold the turn open. Background-pending is a state
  *layered on top of* a settled turn.
- Recovering genuinely lost completion events automatically. Background Bash has a
  weak terminal signal; we bound it with a TTL and surface the wait timer so the user
  can act.

## Background-work sources (the two tiers)

| Source | Tier | Server-visible lifecycle today |
|---|---|---|
| Workflow (`Workflow` tool) | 1 | `workflowWatchers` map + disk-watch terminal (`ClaudeAdapter.ts:2762-2781`, `ClaudeWorkflowWatch.ts`) |
| `spawn_agent` subagent | 1 | `jobs` map with explicit terminal status (`mcp/toolkits/spawn/handlers.ts:92-103`, `putJob`/`patchJob`) |
| Task subagent (`Task`/`Agent`), backgrounded | 2 | `task.updated{isBackgrounded}` → `task.completed` (terminal via `task_notification`, `ClaudeAdapter.ts:3388-3469`) |
| Background Bash (`run_in_background`) | 2 | only an `isBackgrounded` flag on the tool item; **no reliable terminal** |

The first three have reliable terminals. Background Bash does not, so it is tracked
with a bounded TTL (below) to guarantee a missed completion can never pin the pulse
on forever.

## Approach (chosen)

A single in-memory **`BackgroundWorkLedger`** service, keyed by `threadId`, fed by all
four sources and read by two consumers (status projection + reaper). Rejected
alternatives: emitting `background.work.changed` runtime events and folding counts in
ingestion (spawn jobs live in an MCP-toolkit closure that does not emit provider
runtime events; count-from-deltas is fragile across reconnects/restarts); and
deriving "pending" purely from projected read-model data (the projection does not
reliably carry spawn linkage, workflow terminal state, or background-Bash completion —
produces false "live forever" states).

## Components

### 1. Contract — `OrchestrationSession.backgroundWork`

Add a nested, nullable field to `OrchestrationSession`
(`packages/contracts/src/orchestration.ts:306-316`):

```ts
backgroundWork: Schema.NullOr(
  Schema.Struct({
    count: Schema.Number,          // number of pending background operations (>= 1 when present)
    oldestStartedAt: Schema.String // ISO timestamp of the longest-waiting entry
  })
)
```

`null` when there is no pending background work. A nested object (rather than two flat
fields) keeps the two values, which always travel together, atomic and lets the UI
test `session.backgroundWork != null`. It rides the existing thread shell + thread
detail payloads, so both the sidebar list (`subscribeShell`) and the open session view
(`subscribeThread`) receive it over the current WebSocket streams with no transport
changes.

### 2. `BackgroundWorkLedger` service

New server service (`apps/server/src/orchestration/Services/BackgroundWorkLedger.ts`
+ `Layers/BackgroundWorkLedger.ts`), in-memory, backed by a `SubscriptionRef` (or
`PubSub`) so consumers can react to changes.

Entry shape:

```ts
interface BackgroundWorkEntry {
  key: string;                                   // unique within (threadId)
  kind: "workflow" | "subagent" | "task" | "bash";
  startedAt: string;                             // ISO
  expiresAt?: string;                            // ISO; set only for kind === "bash"
}
```

API:

- `register(threadId, entry): Effect<void>` — idempotent on `(threadId, key)`.
- `unregister(threadId, key): Effect<void>` — no-op if absent.
- `snapshotFor(threadId): Effect<{ count: number; oldestStartedAt: string } | null>` —
  count of non-expired entries and the minimum `startedAt`; `null` when empty.
- `changes: Stream<threadId>` — emits the `threadId` whose set changed (including
  TTL-driven changes).
- A scoped sweep fiber removes `bash` entries whose `expiresAt` has passed and emits a
  `changes` signal for affected threads. Sweep interval reuses a small constant
  (e.g. 30 s).

TTL default for `bash`: **10 minutes** from `startedAt` (configurable constant). This
bounds the worst-case false-"live" window for the one source without a reliable
terminal.

### 3. Feeders

- **Workflow** (`ClaudeAdapter.ts:2760-2782`): `register(threadId, {key: runId, kind:
  "workflow", startedAt})` at watcher fork; `unregister(threadId, runId)` in the
  watcher's `Effect.ensuring` terminal. The existing `workflowWatchers` map stays for
  fiber lifecycle; the ledger becomes the source of truth for "pending".
- **spawn_agent** (`mcp/toolkits/spawn/handlers.ts`): `register` in `putJob` when a
  job is created `running` (`key: childThreadId, kind: "subagent"`); `unregister` in
  `patchJob` when it reaches a terminal status. The handler closure needs the ledger
  service injected (it already runs in the server runtime).
- **Task subagent** (`ProviderRuntimeIngestion`, where `task.updated`/`task.completed`
  runtime events are ingested): on `task.updated` with `isBackgrounded === true`,
  `register(threadId, {key: taskId, kind: "task", startedAt})`; on `task.completed`,
  `unregister(threadId, taskId)`. (A non-backgrounded Task runs inside the turn and is
  never registered.)
- **Background Bash** (`ProviderRuntimeIngestion`, tool-item ingestion at
  `:533`-ish where `isBackgrounded` is read): when a tool item first becomes
  `isBackgrounded`, `register(threadId, {key: toolUseId, kind: "bash", startedAt,
  expiresAt = startedAt + 10m})`; `unregister` on that item's completion event if
  observed; otherwise the TTL sweep clears it.

### 4. Projection — `backgroundWork` onto the session

In `ProviderRuntimeIngestion` status decision (`:1470-1552`):

- When building the `thread.session.set` dispatch (any status), read
  `ledger.snapshotFor(threadId)` and include it as `session.backgroundWork`.
- Additionally, subscribe to `ledger.changes`: when the count for a thread changes
  **between turns** (no runtime event of its own would fire), emit a fresh
  `thread.session.set` carrying the updated `backgroundWork` (and the current
  `status`, unchanged) so the UI is pushed the update.

The projector (`projector.ts` `case "thread.session-set"`) stores the new field with
the rest of `session`. **Turn-settling logic is unchanged** — the turn still settles
to `completed`; `backgroundWork` is orthogonal.

### 5. Reaper

Replace the `providerService.hasPendingBackgroundWork(threadId)` check
(`ProviderSessionReaper.ts:110-120`) with `ledger.snapshotFor(threadId) != null`. This
broadens reaper protection from Workflows-only to all four sources. The adapter's
`hasPendingBackgroundWork` method and `ProviderService` passthrough can be removed once
the reaper no longer calls them (or kept as a thin shim over the ledger — decide during
implementation; prefer removal to avoid two sources of truth).

### 6. UI — sidebar pill

`resolveThreadStatusPill` (`apps/web/src/components/Sidebar.logic.ts:338-403`): add a
branch ranked **below** "Working"/"Connecting" (active turn) and below "Pending
Approval"/"Awaiting Input" (user-actionable), but **above** "Completed":

```
hasPendingApprovals      → "Pending Approval"  (amber,   no pulse)
hasPendingUserInput      → "Awaiting Input"    (indigo,  no pulse)
session.status running   → "Working"           (sky,     pulse)
session.status connecting→ "Connecting"        (sky,     pulse)
plan ready               → "Plan Ready"        (violet,  no pulse)
session.backgroundWork   → "Background"        (cyan,    pulse)   ← NEW
hasUnseenCompletion      → "Completed"         (emerald, no pulse)
else                     → null (no dot)
```

The new pill (`ThreadStatusPill`) uses a cyan `dotClass`, `pulse: true`. The
`backgroundWork.count` feeds the compact-variant tooltip ("2 background tasks").
Requires `SidebarThreadSummary.session` / `ThreadSession` (`apps/web/src/types.ts`,
`mapSession` in `store.ts:167-178`) to carry `backgroundWork`, and
`toLegacySessionStatus` is untouched (background-pending is a separate field, not a
status value).

### 7. UI — in-view banner with wait timer

`MessagesTimeline.tsx`: add a timeline row `kind: "background"`, rendered like
`WorkingTimelineRow` (`:667-693`) but with cyan ⟳ treatment and a timer reusing the
`WorkingTimer` pattern (`:696-710`) counting from `backgroundWork.oldestStartedAt`:

> ⟳ Running in background for 1h 12m — 2 task(s), resumes when they finish

Derived in `deriveMessagesTimelineRows` from a new `backgroundWork` input threaded
through `ChatView` (alongside `isWorking`/`activeTurnStartedAt`,
`ChatView.tsx:1940-1941`, `MessagesTimeline.tsx:268-288`). Shown when
`backgroundWork != null && !isWorking` (an active turn's "Working" row takes
precedence). The timer's multi-hour reading is the user's cue that a completion was
likely lost and they can interrupt.

## Edge cases & interactions

- **Synthetic resume:** when a background result lands, `handleAssistantMessage`
  auto-starts a synthetic turn → `status: running` (`ClaudeAdapter.ts:3149-3189`).
  "Working" outranks "Background", so the row swaps to Working, then back to Background
  if work still remains after that synthetic turn settles. The corresponding ledger
  entry is unregistered by its terminal feeder around the same time.
- **Daemon restart:** the ledger is in-memory. On restart, live Workflow watchers and
  spawn jobs re-register as sessions rehydrate (their fibers/jobs are re-established);
  any unrecoverable `bash` entry is simply absent (fail-safe: shows Completed rather
  than stuck-live). No persistence required.
- **Count accuracy:** `register` is idempotent on `(threadId, key)`, so duplicate
  registrations (e.g. repeated `task.updated{isBackgrounded:true}`) do not inflate the
  count.
- **Thread teardown:** on session stop/reap, clear all ledger entries for that thread.

## Testing

- **Ledger unit tests** (`BackgroundWorkLedger.test.ts`): register/unregister,
  idempotency, `snapshotFor` count + `oldestStartedAt`, TTL expiry emits a `changes`
  signal and drops the entry, thread-teardown clears all.
- **Ingestion test**: `turn.completed` with a non-empty ledger projects
  `status: ready` **and** `session.backgroundWork = { count, oldestStartedAt }`; a
  ledger `changes` event between turns emits a fresh `thread.session.set`.
- **Reaper test** (extends `ProviderSessionReaper.test.ts`): a session with a ledger
  entry of each `kind` is **not** reaped; once the ledger empties it becomes eligible.
- **Web logic tests**: `resolveThreadStatusPill` precedence (Working > Background >
  Completed; Approval/Input still outrank Background); `deriveMessagesTimelineRows`
  emits a `background` row only when `backgroundWork != null && !isWorking`.

## Files touched (anticipated)

- `packages/contracts/src/orchestration.ts` — `OrchestrationSession.backgroundWork`.
- `apps/server/src/orchestration/Services/BackgroundWorkLedger.ts` (new) +
  `Layers/BackgroundWorkLedger.ts` (new) + test.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — Workflow feeder; remove/adapt
  `hasPendingBackgroundWork`.
- `apps/server/src/mcp/toolkits/spawn/handlers.ts` — spawn feeder.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — Task/Bash
  feeders, `backgroundWork` projection, `ledger.changes` subscription.
- `apps/server/src/orchestration/projector.ts` — store the field.
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` — read the ledger.
- `apps/server/src/serverRuntimeStartup.ts` / `server.ts` — wire the layer + sweep.
- `apps/web/src/types.ts`, `store.ts` — carry `backgroundWork` into `ThreadSession`.
- `apps/web/src/components/Sidebar.logic.ts`, `ThreadStatusIndicators.tsx` — pill.
- `apps/web/src/components/chat/MessagesTimeline.tsx`, `ChatView.tsx` — banner + timer.
