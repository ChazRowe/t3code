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
3. The session is **not reaped** while background work is pending, for **every**
   background-work source (native SDK tasks — shell/subagent/workflow/monitor — and
   cross-provider `spawn_agent`).
4. The light goes out (row returns to "Completed") only when **all** pending
   background operations have completed.

## Non-goals

- Changing turn-settling semantics. The turn still settles to `completed` at
  `turn.completed`; we do **not** hold the turn open. Background-pending is a state
  *layered on top of* a settled turn.
- Recovering genuinely lost completion events automatically. Every source has a
  reliable terminal (below), but for the rare abnormal case where a terminal never
  arrives, we surface a **wait timer** so the user can spot it and interrupt, and keep
  a generous reaper backstop so a stuck entry cannot pin a session live forever.

## Background-work sources

**Key finding (verified against `@anthropic-ai/claude-agent-sdk@0.3.170`):** all
*native* background work — background Bash **included** — is unified under one SDK
"background task" lifecycle. A backgrounded tool call returns immediately with a
"running in the background" `tool_result`; the task keeps running and emits a terminal
`task_notification` when it settles (`sdk.d.ts` `SDKTaskStartedMessage` →
`SDKTaskNotificationMessage{status: 'completed'|'failed'|'stopped'}`). The task kinds
are enumerated by `BackgroundTaskSummary.type`: **`'shell'`** (background Bash),
`'subagent'` (Task/Agent), `'workflow'`, `'monitor'` (MCP). The daemon's `ClaudeAdapter`
**already** ingests `task_started`/`task_notification` generically as `task.started` /
`task.completed` runtime events (`ClaudeAdapter.ts:3358-3407`), regardless of kind.

| Source | SDK `task_type` | Server-visible terminal today |
|---|---|---|
| Background Bash (`run_in_background`) | `shell` | `task.completed` (terminal `task_notification`) — **reliable** |
| Task subagent (`Task`/`Agent`), backgrounded | `subagent` | `task.completed` — **reliable** |
| Workflow (`Workflow` tool) | `workflow` / `local_workflow` | `task.completed` — **reliable** (also disk-watched for the nested tree, `ClaudeWorkflowWatch.ts`) |
| MCP background task | `monitor` | `task.completed` — **reliable** |
| `spawn_agent` subagent (cross-provider) | *not an SDK task* | `jobs` map explicit terminal status (`mcp/toolkits/spawn/handlers.ts:92-103`) |

So there is **no weak-terminal source.** The earlier design assumed background Bash
had "only an `isBackgrounded` flag, no reliable terminal" — that was wrong: it
conflated background Bash with the Task-subagent `isBackgrounded` flag on
`task_updated`. Background Bash is a first-class `shell` background task with a real
terminal. This collapses tracking to **two feeders** (one unified native-task feeder +
the `spawn_agent` feeder) and removes the per-Bash TTL entirely.

### Why not PID-poll the background shells?

Considered and rejected. (a) **We can't** — a background shell is a grandchild spawned
*inside* the `claude` SDK subprocess; the SDK exposes only a `task_id` / `shell_id` /
`backgroundTaskId`, never an OS PID, so the daemon has nothing to `kill -0`. (b) **We
don't need to** — completion is event-driven via the reliable `task_notification`
terminal, not a guess. (c) Even if we extracted a PID, polling it is fragile: PID
reuse, double-fork daemons that orphan the launcher PID while work continues, and
namespace boundaries would all produce wrong answers. The wait timer (§7) + reaper
backstop (§2) cover the residual "terminal never arrived" case more cheaply and
correctly than a liveness probe.

## Approach (chosen)

A single in-memory **`BackgroundWorkLedger`** service, keyed by `threadId`, fed by two
feeders (the unified native `task.started`/`task.completed` stream, and the
`spawn_agent` jobs map) and read by two consumers (status projection + reaper).
Rejected alternatives: emitting `background.work.changed` runtime events and folding
counts in ingestion (spawn jobs live in an MCP-toolkit closure that does not emit
provider runtime events; count-from-deltas is fragile across reconnects/restarts); and
deriving "pending" purely from projected read-model data (the projection does not
reliably carry spawn linkage or task terminal state — produces false "live forever"
states).

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
  key: string;                                   // unique within (threadId); the task_id or child threadId
  kind: "shell" | "subagent" | "workflow" | "monitor" | "spawn";
  startedAt: string;                             // ISO
}
```

API:

- `register(threadId, entry): Effect<void>` — idempotent on `(threadId, key)`.
- `unregister(threadId, key): Effect<void>` — no-op if absent.
- `clearThread(threadId): Effect<void>` — drop all entries (session stop/teardown).
- `snapshotFor(threadId): Effect<{ count: number; oldestStartedAt: string } | null>` —
  count of live entries and the minimum `startedAt`; `null` when empty.
- `changes: Stream<threadId>` — emits the `threadId` whose set changed (including
  backstop-driven changes).

**Reaper backstop (not a per-source TTL).** Because every source has a reliable
terminal, entries are normally cleared by their `task.completed` / job-terminal / stop
events — there is **no** per-Bash timer. The one residual risk is an entry left open by
*abnormal* turn termination (e.g. an interrupted turn whose in-flight task never emits
`task_notification`); such an entry would otherwise block the reaper forever. To bound
only that case, a scoped sweep fiber expires any entry older than a **generous
backstop** (default **2 hours**, configurable) and emits a `changes` signal. This is
deliberately far longer than any per-Bash TTL would have been: legitimate long-running
background work (a multi-hour build, an all-day monitor) must **not** be dropped from
"live" prematurely — the wait timer (§7) is the user-facing signal for "this has been
pending suspiciously long," and the user interrupts manually. The backstop exists only
so a genuinely stuck entry cannot leak a permanently-unreapable session.

### 3. Feeders

Two feeders, both terminal-reliable:

- **Unified native tasks** (`ProviderRuntimeIngestion`, where the `task.started` /
  `task.completed` runtime events are already ingested, `ClaudeAdapter.ts:3358-3407`):
  on `task.started`, `register(threadId, {key: taskId, kind, startedAt})` where `kind`
  is mapped from the SDK `task_type` (`shell` / `subagent` / `workflow` / `monitor`);
  on `task.completed`, `unregister(threadId, taskId)`. This single feeder covers
  background Bash, backgrounded Task subagents, Workflows, and MCP background tasks.
  - *Counting between turns is correct:* a foreground (blocking) task cannot outlive
    its turn — the turn does not complete until its foreground tools settle — so
    between turns the only open tasks are genuinely backgrounded ones. During an active
    turn the session status is already `running`, which outranks the background pill, so
    any transiently-counted foreground task is irrelevant to the UI and the reaper (the
    reaper skips sessions with `activeTurnId`).
  - *Workflows:* the existing disk-watcher (`ClaudeWorkflowWatch.ts`) stays as-is for
    the nested-tree UI only; it does **not** feed the ledger, so a workflow is counted
    once (via its `task_id`), never double-counted.
- **spawn_agent** (`mcp/toolkits/spawn/handlers.ts`): `register` in `putJob` when a job
  is created `running` (`key: childThreadId, kind: "spawn"`); `unregister` in `patchJob`
  when it reaches a terminal status. The handler closure needs the ledger service
  injected (it already runs in the server runtime). This is a cross-provider real
  session, **not** an SDK task, so it has no `task_id` and cannot collide with the
  unified feeder. If a `spawn_agent` MCP call ever also surfaces as a `monitor` task,
  dedup is by `tool_use_id` (register only one).

The now-redundant `hasPendingBackgroundWork` on `ClaudeAdapter` (which only ever
reflected workflow watchers) is removed in favour of the ledger (see §5).

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
broadens reaper protection from Workflows-only to every source (shell, subagent,
workflow, monitor, spawn). **Remove** the now-redundant `hasPendingBackgroundWork`
method from `ClaudeAdapter` and its `ProviderService` passthrough — the ledger is the
single source of truth (no shim, to avoid two truths).

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
  entry is unregistered by its `task.completed` (or job-terminal) feeder around the
  same time.
- **Abnormal turn termination:** if a turn is interrupted/errors while a task is still
  open, its `task_notification` may never arrive, leaving a stuck ledger entry. The
  reaper backstop (§2) expires it after the generous window; the wait timer surfaces it
  to the user well before then. Additionally, on `session.exited`/stop the feeder
  should best-effort `clearThread`.
- **Daemon restart:** the ledger is in-memory. On restart, spawn jobs re-register as
  sessions rehydrate; native task entries are re-derived only if the SDK re-emits state
  (otherwise simply absent → fail-safe: shows Completed rather than stuck-live). No
  persistence required.
- **Count accuracy:** `register` is idempotent on `(threadId, key)` (the `task_id`), so
  repeated `task.started`/`task.updated` for the same task do not inflate the count.
- **Thread teardown:** on session stop/reap, `clearThread(threadId)`.

## Testing

- **Ledger unit tests** (`BackgroundWorkLedger.test.ts`): register/unregister,
  idempotency, `snapshotFor` count + `oldestStartedAt`, `clearThread`, backstop expiry
  emits a `changes` signal and drops the entry.
- **Ingestion test**: a `task.started` registers and `task.completed` unregisters (per
  `task_type` → `kind`); `turn.completed` with a non-empty ledger projects
  `status: ready` **and** `session.backgroundWork = { count, oldestStartedAt }`; a
  ledger `changes` event between turns emits a fresh `thread.session.set` (including the
  count→0 case → `backgroundWork: null`).
- **Reaper test** (extends `ProviderSessionReaper.test.ts`): a session with a ledger
  entry (task-kind and spawn-kind) is **not** reaped; once the ledger empties it
  becomes eligible.
- **Web logic tests**: `resolveThreadStatusPill` precedence (Working > Background >
  Completed; Approval/Input still outrank Background); `deriveMessagesTimelineRows`
  emits a `background` row only when `backgroundWork != null && !isWorking`.

## Files touched (anticipated)

- `packages/contracts/src/orchestration.ts` — `OrchestrationSession.backgroundWork`.
- `apps/server/src/orchestration/Services/BackgroundWorkLedger.ts` (new) +
  `Layers/BackgroundWorkLedger.ts` (new) + test.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — unified native
  task feeder (`task.started`/`task.completed` → register/unregister), `backgroundWork`
  projection, `ledger.changes` subscription, `clearThread` on `session.exited`.
- `apps/server/src/mcp/toolkits/spawn/handlers.ts` — spawn feeder.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — **remove**
  `hasPendingBackgroundWork` (ledger supersedes it); disk-watcher unchanged.
- `apps/server/src/provider/Services/ProviderAdapter.ts`,
  `Services/ProviderService.ts`, `Layers/ProviderService.ts` — drop the
  `hasPendingBackgroundWork` surface.
- `apps/server/src/orchestration/projector.ts` — store the field.
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` — read the ledger.
- `apps/server/src/serverRuntimeStartup.ts` / `server.ts` — wire the layer + backstop sweep.
- `apps/web/src/types.ts`, `store.ts` — carry `backgroundWork` into `ThreadSession`.
- `apps/web/src/components/Sidebar.logic.ts`, `ThreadStatusIndicators.tsx` — pill.
- `apps/web/src/components/chat/MessagesTimeline.tsx`, `ChatView.tsx` — banner + timer.
