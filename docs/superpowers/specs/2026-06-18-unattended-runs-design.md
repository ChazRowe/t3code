# Unattended Runs — Design Spec

**Date:** 2026-06-18
**Status:** Approved (brainstorming), pending implementation plan
**Branch context:** builds on `feat/sidebar-new-session`

## 1. Problem & Goal

Today, running an agent on a long task by hand means babysitting a wrap → clear →
continue loop: the agent works until its context window fills, invokes a _wrap_
skill to write a handoff document, the human clears context, then invokes a
_continue_ skill that reads the handoff and resumes in a fresh context window.

We want T3 Code to **drive this loop unattended**. The user picks how many
iterations to run, T3 Code tells the agent the run is unattended, and then T3
Code automatically performs the clear-and-continue between each iteration —
while still streaming everything to the UI as normal and letting the user
interrupt at any point.

### Why the clear matters

The whole value of wrap/continue is the **deterministic fresh context** each
iteration. This is categorically different from a provider's internal
auto-compaction (lossy, not under the user's control). An iteration must start
from an _empty_ context window, bridged only by the handoff doc on disk. The
design therefore makes the context clear a first-class step, not an
afterthought.

## 2. Terminology

- **Unattended run** — run-state attached to a single thread: a target
  iteration count `N`, a current index `k`, and a status.
- **Iteration** — one full cycle: agent works in a fresh context → wraps →
  context cleared → `continue` sent. `N` iterations = `N` context windows.
- **Wrap sentinel** — a constant token the agent prints on its own line in the
  final message of a turn that completed a unit of work and wrapped. Default:
  `<<WRAP_COMPLETE>>`.
- **Context clear** — within-thread provider session reset: stop the current
  provider session so the next turn starts a brand-new session id (empty
  context). Same thread, same workspace, fresh window.

## 3. Core Decisions (resolved during brainstorming)

1. **Iteration boundary = wrap sentinel** in the turn's final assistant
   message (not bare turn-idle, not a handoff file watcher).
2. **No-sentinel stop → pause and wait** for the human. The reactor never
   auto-answers questions or approvals.
3. **Loop lives server-side, event-sourced.** Survives browser close,
   reconnect, and server restart (state rebuilds from the projection).
4. **Clear = within-thread session reset.** One readable thread per run, N
   internal context windows. (Not new-thread-per-iteration.)

## 4. Architecture

The loop is modeled as orchestration state on a thread and driven by a new
server reactor, consistent with the existing event-sourced command → event →
projection pattern.

```
User (web)                 Orchestration (events)            UnattendedRunReactor
   |                              |                                  |
   |-- unattended-run.start ----->|                                  |
   |                              |-- unattended-run-started ------->|
   |                              |                                  |-- turn.start (preamble, iter 1)
   |          <-------- streaming turn as normal -------->           |
   |                              |  (turn ends, session leaves      |
   |                              |   "running")                     |-- read final text
   |                              |                                  |   sentinel?
   |                              |                                  |     yes & k<N:
   |                              |<-- session.stop (CLEAR) ---------|
   |                              |  (session -> "stopped")          |-- wait for stopped
   |                              |<-- unattended-iteration-advanced-|
   |                              |<-- turn.start (continue, iter k+1)
   |                              |                                  |     no:
   |                              |<-- unattended-run-paused --------|
```

### 4.1 Orchestration events (new)

Added to `packages/contracts/src/orchestration.ts` and the server-internal
alias surface in `orchestration/Schemas.ts`:

- `thread.unattended-run-started` — `{ threadId, totalIterations, startedAt }`
- `thread.unattended-iteration-advanced` — `{ threadId, iteration }`
  (emitted when a `continue` is dispatched, i.e. iteration `k+1` begins)
- `thread.unattended-run-paused` — `{ threadId, reason, iteration }`
  where `reason ∈ { "no-sentinel", "error", "manual" }`
- `thread.unattended-run-resumed` — `{ threadId }`
- `thread.unattended-run-finished` — `{ threadId, outcome, iteration }`
  where `outcome ∈ { "completed", "stopped" }`

### 4.2 Commands (new)

- `thread.unattended-run.start` — `{ threadId, totalIterations }`
- `thread.unattended-run.pause` — `{ threadId }`
- `thread.unattended-run.resume` — `{ threadId }`
- `thread.unattended-run.stop` — `{ threadId }`

Deciders (`orchestration/decider.ts`) validate invariants (e.g. start requires
no active run; `totalIterations >= 1`) and emit the corresponding events.

### 4.3 Read model / projector

The projector (`orchestration/projector.ts` and `ProjectionPipeline.ts`) folds
the events into a new thread field:

```ts
thread.unattendedRun: {
  status: "running" | "paused" | "completed" | "stopped";
  totalIterations: number;
  currentIteration: number;       // 1-based; the iteration currently executing
  pauseReason?: "no-sentinel" | "error" | "manual";
} | null
```

`null` when the thread has no run. This field is what the web banner renders and
what the reactor reads to rehydrate after restart.

### 4.4 UnattendedRunReactor (new)

A server reactor (sibling of `ProviderCommandReactor`, wired into
`OrchestrationReactor.start`). Subscribes to the orchestration event stream and
maintains a small per-thread state machine driven by the read model:

- **On `unattended-run-started`:** issue `thread.turn.start` with the
  **unattended preamble** message (§5), iteration 1.
- **On thread turn-end** (session leaving `"running"` — the existing turn-end
  signal at `projector.ts:464`) _for a thread with a `running` unattended run_:
  read the turn's final assistant text.
  - **Sentinel present, `k < N`:** issue `thread.session.stop`; once the read
    model shows `session.status === "stopped"`, emit
    `unattended-iteration-advanced` and issue `thread.turn.start` with the
    **continue** message.
  - **Sentinel present, `k === N`:** emit `unattended-run-finished:
completed`.
  - **Sentinel absent:** emit `unattended-run-paused: no-sentinel`.
- **On provider error / interrupt while a run is `running`:** emit
  `unattended-run-paused` (`error` / `manual`).
- **On `unattended-run-resumed`:** set status back to `running` and re-arm the
  reactor to watch turn-ends. Resume itself **never clears context** — a clear
  only ever happens in response to a sentinel (clearing without a handoff would
  destroy un-wrapped work). Concretely: if a turn is currently running, the
  reactor simply waits for its turn-end and applies the normal sentinel logic;
  if the thread is idle, it issues a `continue` to kick the next iteration.

  This makes the "agent asked a question" flow clean: the run pauses
  (`no-sentinel`), the user types an answer (a normal turn runs and ends without
  a sentinel — the run stays paused), the user reads the result and hits
  **Resume**, and the loop picks back up from there without losing context.

The reactor reads/writes only through the orchestration engine
(commands/events); it holds no durable state of its own, so a restart replays
from the projection and continues.

#### Failure handling around the clear

If `thread.session.stop` fails, or the subsequent fresh `thread.turn.start`
fails, the reactor emits `unattended-run-paused: error` instead of continuing.
It never sends `continue` onto a context window it could not verify was cleared.

## 5. Prompts & sentinel (single constants module)

A new constants module (e.g. `apps/server/src/orchestration/unattendedRun.ts`)
owns three editable values so wording is easy to tune:

- **`WRAP_SENTINEL = "<<WRAP_COMPLETE>>"`** — shared by the reactor's scan
  and the wrap skill's output.
- **Unattended preamble** (iteration 1 message): states that this is an
  unattended run of `N` iterations, that no human will respond mid-run, and the
  contract:
  > Do as much as you can this context window. When you reach a good stopping
  > point or your context is filling, invoke your wrap skill to write the
  > handoff, then end your message with `<<WRAP_COMPLETE>>` on its own line.
  > If you need a human decision, stop and ask **without** the sentinel — the
  > run will pause for me.
- **Continue message** (iterations 2..N): the user's `continue` invocation text,
  instructing the agent to read the handoff doc and resume.

### Wrap skill change (user-side, out of repo)

The user's wrap skill gets a one-line addition: end its final message with the
sentinel on its own line. This is the only change required outside T3 Code.

## 6. UI

All in `apps/web`. Normal turn streaming/rendering is unchanged — the user
watches each iteration work exactly as today.

- **Start:** a "Start unattended run…" item in the composer controls menu
  (`CompactComposerControlsMenu`) opens a small dialog: an iteration-count input
  and a read-only preview of the preamble. Disabled while a turn is already
  running or a run is active.
- **Live status banner** (in `ComposerBannerStack`):
  `Unattended run · iteration k of N · <status>` with **Pause**, **Resume**,
  **Stop** buttons as applicable. Shows the context-clear boundary between
  iterations in the timeline.
- **Interrupt:** the existing interrupt button still works; interrupting a run
  pauses it (reason `manual`) rather than silently killing it.
- **Paused state:** banner turns amber and explains the reason (e.g. "agent
  stopped without wrapping — it may be asking a question"), offering Resume /
  Stop. Typing a manual message leaves the run paused (the user has taken over).

State flows over the existing WebSocket projection; the banner is derived from
`thread.unattendedRun`.

## 7. Reliability & Edge Cases

- **Reconnect / server restart:** run state is event-sourced; both banner and
  reactor reconstruct from the projection.
- **No infinite spin:** the loop only advances on an explicit sentinel; absence
  pauses. Errors pause.
- **Clear verified before continue:** continue is only dispatched after the
  session is observed `"stopped"` (§4.4).
- **One run per thread:** enforced by the `unattendedRun` read-model field at the
  decider.
- **Manual takeover:** a user message during a run pauses it (`manual`).
- **Count bounds:** `totalIterations >= 1`; an upper sanity cap (e.g. 100) is
  enforced at the decider to prevent runaway input.

## 8. Testing

Following repo TDD norms (`vp check`, `vp run typecheck`, `vp test` must pass):

- **Decider tests:** each new command → event mapping and invariant
  (start-requires-no-active-run, bounds, pause/resume/stop transitions).
- **Projector / ProjectionPipeline tests:** `unattendedRun` field folding across
  the full event sequence, including rehydration after a simulated restart.
- **UnattendedRunReactor tests:** sentinel → clear → advance; no-sentinel →
  pause; `k === N` → finished; session.stop failure → pause(error);
  interrupt → pause(manual); resume re-entry.
- **Web logic tests:** banner state machine derivation from `thread.unattendedRun`
  and the start-dialog gating.

## 9. Out of Scope

- Changing provider auto-compaction behavior.
- The wrap/continue skills themselves (user-owned; only the sentinel line is
  added).
- Cross-thread or multi-thread orchestration of runs.
- Scheduling runs to start later (this is start-now only).
