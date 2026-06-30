# Unattended Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user start an unattended run on a thread — pick N iterations, and T3 Code automatically drives the agent's wrap → clear-context → continue loop N times, pausing for the user whenever the agent stops without wrapping.

**Architecture:** Event-sourced. New orchestration commands/events model run state on a thread; a new server `UnattendedRunReactor` subscribes to the domain event stream and drives the loop (detect wrap sentinel → stop session to clear context → re-issue `continue`). Run state persists as a JSON column on `projection_threads`, so the reactor and the web banner both survive reconnect and server restart. The web app gains a start dialog, a status banner, and event reducers.

**Tech Stack:** TypeScript, Effect (effect-smol), Effect Schema, SQLite projections, React/Vite, vite-plus test runner.

## Global Constraints

- `vp check` and `vp run typecheck` must pass before a task is considered done. (AGENTS.md)
- Run a single server test file with: `cd /home/chaz/projects/t3code/apps/server && vp test run src/<path>.test.ts`. Run a single web test similarly under `apps/web`.
- Performance, reliability, and predictable behavior under failures (restarts, reconnects, partial streams) take priority over convenience. (AGENTS.md)
- DRY: shared fold logic lives in exactly one place (`@t3tools/shared/unattendedRun`). Do not duplicate it across the three projection/store sites.
- `packages/contracts` is schema-only — no runtime logic. Pure reducers go in `packages/shared`.
- Effect style: read `.repos/effect-smol/LLMS.md` before writing Effect code; mirror existing modules.
- **Canonical names** (use verbatim everywhere):
  - Event type strings: `thread.unattended-run-started`, `thread.unattended-run-iteration-advanced`, `thread.unattended-run-paused`, `thread.unattended-run-resumed`, `thread.unattended-run-finished`.
  - Client command type strings: `thread.unattended-run.start`, `thread.unattended-run.pause`, `thread.unattended-run.resume`, `thread.unattended-run.stop`.
  - Internal command type strings: `thread.unattended-run.advance`, `thread.unattended-run.fault`, `thread.unattended-run.complete`.
  - Statuses: `running | paused | completed | stopped`. Pause reasons: `no-sentinel | error | manual`. Outcomes: `completed | stopped`.
  - Wrap sentinel: `<<WRAP_COMPLETE>>`. Max iterations: `100`.

---

## File Structure

**New files:**

- `packages/shared/src/unattendedRun.ts` — pure `UnattendedRunState` fold reducer + helpers (`applyUnattendedRunEvent`). Exported via subpath `@t3tools/shared/unattendedRun`.
- `apps/server/src/orchestration/unattendedRun.ts` — server constants: `WRAP_SENTINEL`, `buildUnattendedPreamble`, `CONTINUE_MESSAGE`, `messageHasWrapSentinel`.
- `apps/server/src/orchestration/Services/UnattendedRunReactor.ts` — reactor Service tag + shape.
- `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts` — reactor implementation.
- `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts` — reactor tests.
- `apps/server/src/persistence/Migrations/NNN_ProjectionThreadsUnattendedRun.ts` — ADD COLUMN migration.
- `apps/web/src/components/chat/UnattendedRunDialog.tsx` — start dialog.
- `apps/web/src/components/chat/unattendedRunBanner.ts` — pure builder for the banner stack item + logic test.

**Modified files:**

- `packages/contracts/src/orchestration.ts` — domain types, commands, events, `OrchestrationThread.unattendedRun`.
- `packages/shared/package.json` — add the `./unattendedRun` subpath export.
- `apps/server/src/orchestration/Schemas.ts` — alias new payloads.
- `apps/server/src/orchestration/decider.ts` — 7 new command cases.
- `apps/server/src/orchestration/projector.ts` — 5 new event cases + init in `thread.created`.
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — write column in `applyThreadsProjection`.
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — row schema field.
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` — upsert/select column.
- `apps/server/src/persistence/Migrations.ts` — register migration.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — select + assemble field (2 sites + row schema).
- `apps/server/src/orchestration/Layers/OrchestrationReactor.ts` + `apps/server/src/server.ts` — wire reactor.
- `apps/web/src/types.ts` — `Thread.unattendedRun`.
- `apps/web/src/store.ts` — 5 reducer cases + init.
- `apps/web/src/hooks/useThreadActions.ts` (or sibling) — 4 command senders.
- `apps/web/src/components/chat/CompactComposerControlsMenu.tsx` + `ChatComposer.tsx` — menu item + wiring.
- `apps/web/src/components/ChatView.tsx` — banner item + dialog mount + handlers.

---

## PHASE 1 — Contracts & shared types

### Task 1: Unattended run domain types in contracts

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`

**Interfaces:**

- Produces: `UnattendedRunStatus`, `UnattendedRunPauseReason`, `UnattendedRunOutcome`, `UNATTENDED_RUN_MAX_ITERATIONS`, `UnattendedRunState` (+ `.Type` exports). `UnattendedRunState` = `{ status, totalIterations, currentIteration, pauseReason: reason|null, startedAt, updatedAt }`.

- [ ] **Step 1: Add the domain types.** Insert after the `ProviderInteractionMode` block (near line 126), mirroring the existing `Schema.Literals` / `Schema.Struct` style. Use `PositiveInt` and the `Schema.Int.check(Schema.isBetween(...))` patterns already imported via baseSchemas.

```ts
export const UNATTENDED_RUN_MAX_ITERATIONS = 100;

export const UnattendedRunStatus = Schema.Literals(["running", "paused", "completed", "stopped"]);
export type UnattendedRunStatus = typeof UnattendedRunStatus.Type;

export const UnattendedRunPauseReason = Schema.Literals(["no-sentinel", "error", "manual"]);
export type UnattendedRunPauseReason = typeof UnattendedRunPauseReason.Type;

export const UnattendedRunOutcome = Schema.Literals(["completed", "stopped"]);
export type UnattendedRunOutcome = typeof UnattendedRunOutcome.Type;

export const UnattendedRunIterations = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: UNATTENDED_RUN_MAX_ITERATIONS }),
);

export const UnattendedRunState = Schema.Struct({
  status: UnattendedRunStatus,
  totalIterations: UnattendedRunIterations,
  currentIteration: PositiveInt,
  pauseReason: Schema.NullOr(UnattendedRunPauseReason),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type UnattendedRunState = typeof UnattendedRunState.Type;
```

- [ ] **Step 2: Verify `PositiveInt` is imported.** Check the import block from `./baseSchemas` (top of file, ~line 9-22) includes `PositiveInt`. If absent, add it to that import list. Confirm with:

Run: `cd /home/chaz/projects/t3code && grep -n "PositiveInt" packages/contracts/src/baseSchemas.ts`
Expected: a line defining `export const PositiveInt = ...`.

- [ ] **Step 3: Typecheck.**

Run: `cd /home/chaz/projects/t3code && vp run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit.**

```bash
git add packages/contracts/src/orchestration.ts
git commit -m "feat(contracts): add UnattendedRunState domain types"
```

### Task 2: Add `unattendedRun` to OrchestrationThread read model

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`

**Interfaces:**

- Consumes: `UnattendedRunState` (Task 1).
- Produces: `OrchestrationThread.unattendedRun: UnattendedRunState | null`.

- [ ] **Step 1: Add the field.** In `OrchestrationThread` (the `Schema.Struct` at ~line 344), add directly after the `session:` line:

```ts
  session: Schema.NullOr(OrchestrationSession),
  unattendedRun: Schema.NullOr(UnattendedRunState).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
```

(The `withDecodingDefault(null)` keeps older persisted/serialized threads decodable.)

- [ ] **Step 2: Typecheck.** This will reveal every site that constructs an `OrchestrationThread` (projector, snapshot assembly, tests) — those are fixed in later tasks. At this point only contracts should compile cleanly; server may show errors that later tasks resolve. Confirm contracts package itself is clean:

Run: `cd /home/chaz/projects/t3code/packages/contracts && vp run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add packages/contracts/src/orchestration.ts
git commit -m "feat(contracts): add unattendedRun field to OrchestrationThread"
```

### Task 3: Unattended run commands in contracts

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`

**Interfaces:**

- Produces: 4 client commands + 3 internal commands, all wired into the relevant unions. Field shapes:
  - start: `{ type, commandId, threadId, totalIterations, createdAt }`
  - pause/resume/stop/advance/complete: `{ type, commandId, threadId, createdAt }`
  - fault: `{ type, commandId, threadId, reason: UnattendedRunPauseReason, createdAt }`

- [ ] **Step 1: Define the command structs.** Place near the other thread command structs (after `ThreadSessionStopCommand`, ~line 650). Mirror `ThreadRuntimeModeSetCommand` style.

```ts
const ThreadUnattendedRunStartCommand = Schema.Struct({
  type: Schema.Literal("thread.unattended-run.start"),
  commandId: CommandId,
  threadId: ThreadId,
  totalIterations: UnattendedRunIterations,
  createdAt: IsoDateTime,
});
const ThreadUnattendedRunPauseCommand = Schema.Struct({
  type: Schema.Literal("thread.unattended-run.pause"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
const ThreadUnattendedRunResumeCommand = Schema.Struct({
  type: Schema.Literal("thread.unattended-run.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
const ThreadUnattendedRunStopCommand = Schema.Struct({
  type: Schema.Literal("thread.unattended-run.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
const ThreadUnattendedRunAdvanceCommand = Schema.Struct({
  type: Schema.Literal("thread.unattended-run.advance"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
const ThreadUnattendedRunFaultCommand = Schema.Struct({
  type: Schema.Literal("thread.unattended-run.fault"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: UnattendedRunPauseReason,
  createdAt: IsoDateTime,
});
const ThreadUnattendedRunCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.unattended-run.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
```

- [ ] **Step 2: Add the 4 client commands to both client unions.** In `DispatchableClientOrchestrationCommand` (~line 659) and `ClientOrchestrationCommand` (~line 680), add these four members (after `ThreadSessionStopCommand`):

```ts
  ThreadUnattendedRunStartCommand,
  ThreadUnattendedRunPauseCommand,
  ThreadUnattendedRunResumeCommand,
  ThreadUnattendedRunStopCommand,
```

- [ ] **Step 3: Add the 3 internal commands to `InternalOrchestrationCommand`** (~line 765, after `ThreadRevertCompleteCommand`):

```ts
  ThreadUnattendedRunAdvanceCommand,
  ThreadUnattendedRunFaultCommand,
  ThreadUnattendedRunCompleteCommand,
```

- [ ] **Step 4: Typecheck contracts.**

Run: `cd /home/chaz/projects/t3code/packages/contracts && vp run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/contracts/src/orchestration.ts
git commit -m "feat(contracts): add unattended run commands"
```

### Task 4: Unattended run events in contracts

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`

**Interfaces:**

- Produces: 5 event-type literals, 5 payload schemas, 5 `OrchestrationEvent` union members.
  - started payload: `{ threadId, totalIterations, startedAt, updatedAt }`
  - iteration-advanced payload: `{ threadId, iteration, updatedAt }`
  - paused payload: `{ threadId, reason: UnattendedRunPauseReason, updatedAt }`
  - resumed payload: `{ threadId, updatedAt }`
  - finished payload: `{ threadId, outcome: UnattendedRunOutcome, iteration, updatedAt }`

- [ ] **Step 1: Add event-type literals.** In `OrchestrationEventType` (`Schema.Literals([...])`, ~line 782), append:

```ts
  "thread.unattended-run-started",
  "thread.unattended-run-iteration-advanced",
  "thread.unattended-run-paused",
  "thread.unattended-run-resumed",
  "thread.unattended-run-finished",
```

- [ ] **Step 2: Add payload schemas.** Place near the other thread payloads (after `ThreadInteractionModeSetPayload`, ~line 890). Use `PositiveInt` for `iteration`.

```ts
export const ThreadUnattendedRunStartedPayload = Schema.Struct({
  threadId: ThreadId,
  totalIterations: UnattendedRunIterations,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export const ThreadUnattendedRunIterationAdvancedPayload = Schema.Struct({
  threadId: ThreadId,
  iteration: PositiveInt,
  updatedAt: IsoDateTime,
});
export const ThreadUnattendedRunPausedPayload = Schema.Struct({
  threadId: ThreadId,
  reason: UnattendedRunPauseReason,
  updatedAt: IsoDateTime,
});
export const ThreadUnattendedRunResumedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});
export const ThreadUnattendedRunFinishedPayload = Schema.Struct({
  threadId: ThreadId,
  outcome: UnattendedRunOutcome,
  iteration: PositiveInt,
  updatedAt: IsoDateTime,
});
```

- [ ] **Step 3: Add union members.** In the `OrchestrationEvent = Schema.Union([...])` (~line 1000), append 5 structs mirroring the existing pattern:

```ts
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unattended-run-started"),
    payload: ThreadUnattendedRunStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unattended-run-iteration-advanced"),
    payload: ThreadUnattendedRunIterationAdvancedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unattended-run-paused"),
    payload: ThreadUnattendedRunPausedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unattended-run-resumed"),
    payload: ThreadUnattendedRunResumedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unattended-run-finished"),
    payload: ThreadUnattendedRunFinishedPayload,
  }),
```

- [ ] **Step 4: Typecheck contracts.**

Run: `cd /home/chaz/projects/t3code/packages/contracts && vp run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/contracts/src/orchestration.ts
git commit -m "feat(contracts): add unattended run events"
```

### Task 5: Alias new payloads in server Schemas.ts

**Files:**

- Modify: `apps/server/src/orchestration/Schemas.ts`

**Interfaces:**

- Produces: server-internal aliases mirroring the contract payloads (used by decider/projector for decoding).

- [ ] **Step 1: Import + alias.** Add the five payloads to the import from `@t3tools/contracts` and re-export them, mirroring the existing alias lines (e.g. `ThreadRuntimeModeSetPayload`).

```ts
  ThreadUnattendedRunStartedPayload as ContractsThreadUnattendedRunStartedPayloadSchema,
  ThreadUnattendedRunIterationAdvancedPayload as ContractsThreadUnattendedRunIterationAdvancedPayloadSchema,
  ThreadUnattendedRunPausedPayload as ContractsThreadUnattendedRunPausedPayloadSchema,
  ThreadUnattendedRunResumedPayload as ContractsThreadUnattendedRunResumedPayloadSchema,
  ThreadUnattendedRunFinishedPayload as ContractsThreadUnattendedRunFinishedPayloadSchema,
```

```ts
export const ThreadUnattendedRunStartedPayload = ContractsThreadUnattendedRunStartedPayloadSchema;
export const ThreadUnattendedRunIterationAdvancedPayload =
  ContractsThreadUnattendedRunIterationAdvancedPayloadSchema;
export const ThreadUnattendedRunPausedPayload = ContractsThreadUnattendedRunPausedPayloadSchema;
export const ThreadUnattendedRunResumedPayload = ContractsThreadUnattendedRunResumedPayloadSchema;
export const ThreadUnattendedRunFinishedPayload = ContractsThreadUnattendedRunFinishedPayloadSchema;
```

- [ ] **Step 2: Typecheck.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp run typecheck`
Expected: errors only in not-yet-edited decider/projector/snapshot (expected); `Schemas.ts` itself clean.

- [ ] **Step 3: Commit.**

```bash
git add apps/server/src/orchestration/Schemas.ts
git commit -m "feat(server): alias unattended run payloads"
```

---

## PHASE 2 — Shared fold reducer + server constants

### Task 6: Pure `applyUnattendedRunEvent` reducer in shared

**Files:**

- Create: `packages/shared/src/unattendedRun.ts`
- Modify: `packages/shared/package.json`
- Test: `packages/shared/src/unattendedRun.test.ts`

**Interfaces:**

- Produces: `applyUnattendedRunEvent(current: UnattendedRunState | null, event: OrchestrationEvent): UnattendedRunState | null`. Pure; ignores non-unattended events (returns `current` unchanged). This is the single fold used by the in-memory projector, the SQL projection, and the web store.

- [ ] **Step 1: Write the failing test.**

```ts
// packages/shared/src/unattendedRun.test.ts
import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyUnattendedRunEvent } from "./unattendedRun.ts";

const base = {
  sequence: 1,
  eventId: "e1",
  aggregateKind: "thread",
  aggregateId: "t1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const ev = (type: string, payload: unknown): OrchestrationEvent =>
  ({ ...base, type, payload }) as unknown as OrchestrationEvent;

describe("applyUnattendedRunEvent", () => {
  it("starts a run at iteration 1, status running", () => {
    const next = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 3,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    expect(next).toEqual({
      status: "running",
      totalIterations: 3,
      currentIteration: 1,
      pauseReason: null,
      startedAt: base.occurredAt,
      updatedAt: base.occurredAt,
    });
  });

  it("advances the iteration counter", () => {
    const started = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 3,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    const advanced = applyUnattendedRunEvent(
      started,
      ev("thread.unattended-run-iteration-advanced", {
        threadId: "t1",
        iteration: 2,
        updatedAt: "2026-01-01T00:01:00.000Z",
      }),
    );
    expect(advanced?.currentIteration).toBe(2);
    expect(advanced?.status).toBe("running");
  });

  it("pauses with a reason and resumes back to running", () => {
    let s = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 2,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    s = applyUnattendedRunEvent(
      s,
      ev("thread.unattended-run-paused", {
        threadId: "t1",
        reason: "no-sentinel",
        updatedAt: base.occurredAt,
      }),
    );
    expect(s).toMatchObject({ status: "paused", pauseReason: "no-sentinel" });
    s = applyUnattendedRunEvent(
      s,
      ev("thread.unattended-run-resumed", { threadId: "t1", updatedAt: base.occurredAt }),
    );
    expect(s).toMatchObject({ status: "running", pauseReason: null });
  });

  it("finishes (completed/stopped) and leaves a terminal state", () => {
    const started = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 1,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    const finished = applyUnattendedRunEvent(
      started,
      ev("thread.unattended-run-finished", {
        threadId: "t1",
        outcome: "completed",
        iteration: 1,
        updatedAt: base.occurredAt,
      }),
    );
    expect(finished).toMatchObject({ status: "completed" });
  });

  it("ignores unrelated events", () => {
    const started = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 1,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    const same = applyUnattendedRunEvent(started, ev("thread.message-sent", { threadId: "t1" }));
    expect(same).toBe(started);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails.**

Run: `cd /home/chaz/projects/t3code/packages/shared && vp test run src/unattendedRun.test.ts`
Expected: FAIL — `applyUnattendedRunEvent` not found.

- [ ] **Step 3: Implement the reducer.**

```ts
// packages/shared/src/unattendedRun.ts
import type { OrchestrationEvent, UnattendedRunState } from "@t3tools/contracts";

/**
 * Fold an orchestration event into a thread's unattended-run state. Pure and
 * total: events that are not unattended-run events return `current` unchanged
 * (by reference, so callers can short-circuit). This is the single source of
 * truth shared by the in-memory projector, the SQL projection, and the web store.
 */
export const applyUnattendedRunEvent = (
  current: UnattendedRunState | null,
  event: OrchestrationEvent,
): UnattendedRunState | null => {
  switch (event.type) {
    case "thread.unattended-run-started":
      return {
        status: "running",
        totalIterations: event.payload.totalIterations,
        currentIteration: 1,
        pauseReason: null,
        startedAt: event.payload.startedAt,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unattended-run-iteration-advanced":
      if (current === null) return current;
      return {
        ...current,
        status: "running",
        currentIteration: event.payload.iteration,
        pauseReason: null,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unattended-run-paused":
      if (current === null) return current;
      return {
        ...current,
        status: "paused",
        pauseReason: event.payload.reason,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unattended-run-resumed":
      if (current === null) return current;
      return {
        ...current,
        status: "running",
        pauseReason: null,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unattended-run-finished":
      if (current === null) return current;
      return {
        ...current,
        status: event.payload.outcome,
        currentIteration: event.payload.iteration,
        pauseReason: null,
        updatedAt: event.payload.updatedAt,
      };
    default:
      return current;
  }
};
```

- [ ] **Step 4: Add the subpath export.** In `packages/shared/package.json`, mirror an existing subpath (e.g. `./git`) under `"exports"`:

```json
    "./unattendedRun": "./src/unattendedRun.ts",
```

(Match the exact shape of neighboring entries — some use `{ "types": ..., "default": ... }`; copy that shape if so.)

- [ ] **Step 5: Run the test to confirm it passes.**

Run: `cd /home/chaz/projects/t3code/packages/shared && vp test run src/unattendedRun.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit.**

```bash
git add packages/shared/src/unattendedRun.ts packages/shared/src/unattendedRun.test.ts packages/shared/package.json
git commit -m "feat(shared): pure unattended run fold reducer"
```

### Task 7: Server constants — sentinel & prompts

**Files:**

- Create: `apps/server/src/orchestration/unattendedRun.ts`
- Test: `apps/server/src/orchestration/unattendedRun.test.ts`

**Interfaces:**

- Produces: `WRAP_SENTINEL: string`, `messageHasWrapSentinel(text: string): boolean`, `buildUnattendedPreamble(totalIterations: number): string`, `CONTINUE_MESSAGE: string`.

- [ ] **Step 1: Write the failing test.**

```ts
// apps/server/src/orchestration/unattendedRun.test.ts
import { describe, expect, it } from "vite-plus/test";

import {
  buildUnattendedPreamble,
  CONTINUE_MESSAGE,
  messageHasWrapSentinel,
  WRAP_SENTINEL,
} from "./unattendedRun.ts";

describe("unattended run constants", () => {
  it("detects the sentinel on its own line", () => {
    expect(messageHasWrapSentinel(`done\n${WRAP_SENTINEL}`)).toBe(true);
    expect(messageHasWrapSentinel(`${WRAP_SENTINEL}\n`)).toBe(true);
  });

  it("does not treat an unrelated message as a wrap", () => {
    expect(messageHasWrapSentinel("still thinking, here is a question?")).toBe(false);
    expect(messageHasWrapSentinel("")).toBe(false);
  });

  it("preamble mentions the iteration count and the sentinel", () => {
    const preamble = buildUnattendedPreamble(5);
    expect(preamble).toContain("5");
    expect(preamble).toContain(WRAP_SENTINEL);
  });

  it("has a non-empty continue message", () => {
    expect(CONTINUE_MESSAGE.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/unattendedRun.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

```ts
// apps/server/src/orchestration/unattendedRun.ts

/** Sentinel the agent prints on its own line after wrapping an iteration. */
export const WRAP_SENTINEL = "<<WRAP_COMPLETE>>";

/** True when the agent's final message signals a completed wrap. */
export const messageHasWrapSentinel = (text: string): boolean => text.includes(WRAP_SENTINEL);

/** Message that opens iteration 1 and sets the unattended contract. */
export const buildUnattendedPreamble = (totalIterations: number): string =>
  [
    `This is an UNATTENDED run of ${totalIterations} iteration(s). No human will`,
    `respond between iterations.`,
    ``,
    `Do as much as you can this context window. When you reach a good stopping`,
    `point, or your context is filling, invoke your wrap skill to write the`,
    `handoff document, then end your message with the line:`,
    ``,
    WRAP_SENTINEL,
    ``,
    `on its own line. Seeing that line, I will clear the context and send you a`,
    `"continue" so you can resume from the handoff.`,
    ``,
    `If you instead need a human decision, STOP and ask your question WITHOUT the`,
    `sentinel line — the run will pause for me.`,
  ].join("\n");

/** Message sent for iterations 2..N after the context is cleared. */
export const CONTINUE_MESSAGE =
  "continue — read the latest handoff document and resume the unattended run.";
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/unattendedRun.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/orchestration/unattendedRun.ts apps/server/src/orchestration/unattendedRun.test.ts
git commit -m "feat(server): unattended run sentinel and prompt constants"
```

---

## PHASE 3 — Decider (command → event)

### Task 8: Decider cases for the 7 unattended commands

**Files:**

- Modify: `apps/server/src/orchestration/decider.ts`
- Test: `apps/server/src/orchestration/decider.unattendedRun.test.ts`

**Interfaces:**

- Consumes: `requireThread`, `withEventBase`, `nowIso`, `OrchestrationCommandInvariantError` (already in `decider.ts`); `applyUnattendedRunEvent` is NOT used here (decider validates against the read model's `thread.unattendedRun`).
- Produces: each command emits exactly one event. Invariants:
  - `start`: thread has no active (`running`/`paused`) run → emit `started`.
  - `advance`: run is `running` → emit `iteration-advanced` with `iteration = currentIteration + 1`.
  - `pause`: run is `running` → emit `paused` reason `manual`.
  - `fault`: run is `running` → emit `paused` reason from command.
  - `resume`: run is `paused` → emit `resumed`.
  - `stop`: run is `running` or `paused` → emit `finished` outcome `stopped`, iteration `currentIteration`.
  - `complete`: run is `running` → emit `finished` outcome `completed`, iteration `currentIteration`.

- [ ] **Step 1: Write the failing test.** Model it on `decider.delete.test.ts` (seed a thread via `projectEvent`, then call `decideOrchestrationCommand`). Build a `seedThreadWithRun` helper that emits `thread.created` then (optionally) `thread.unattended-run-started` through `projectEvent`.

```ts
// apps/server/src/orchestration/decider.unattendedRun.test.ts
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const asThreadId = (s: string) => ThreadId.make(s);
const asProjectId = (s: string) => ProjectId.make(s);
const asEventId = (s: string) => EventId.make(s);

const seedThread = Effect.fn(function* (opts: { started?: boolean; total?: number }) {
  let model = createEmptyReadModel(now);
  model = yield* projectEvent(model, {
    sequence: 1,
    eventId: asEventId("e-proj"),
    aggregateKind: "project",
    aggregateId: asProjectId("p1"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("c-proj"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId: asProjectId("p1"),
      title: "P",
      workspaceRoot: "/tmp/p",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  } as never);
  model = yield* projectEvent(model, {
    sequence: 2,
    eventId: asEventId("e-thread"),
    aggregateKind: "thread",
    aggregateId: asThreadId("t1"),
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("c-thread"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: asThreadId("t1"),
      projectId: asProjectId("p1"),
      title: "T",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  } as never);
  if (opts.started) {
    model = yield* projectEvent(model, {
      sequence: 3,
      eventId: asEventId("e-run"),
      aggregateKind: "thread",
      aggregateId: asThreadId("t1"),
      type: "thread.unattended-run-started",
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: asThreadId("t1"),
        totalIterations: opts.total ?? 3,
        startedAt: now,
        updatedAt: now,
      },
    } as never);
  }
  return model;
});

it.layer(NodeServices.layer)("decider unattended run", (it) => {
  it.effect("start emits started", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({});
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.start",
          commandId: CommandId.make("c1"),
          threadId: asThreadId("t1"),
          totalIterations: 3,
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-started");
      expect((event.payload as { totalIterations: number }).totalIterations).toBe(3);
    }),
  );

  it.effect("start fails when a run is already active", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true });
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.unattended-run.start",
            commandId: CommandId.make("c2"),
            threadId: asThreadId("t1"),
            totalIterations: 2,
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("advance increments the iteration", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true, total: 3 });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.advance",
          commandId: CommandId.make("c3"),
          threadId: asThreadId("t1"),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-iteration-advanced");
      expect((event.payload as { iteration: number }).iteration).toBe(2);
    }),
  );

  it.effect("fault emits paused with the given reason", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.fault",
          commandId: CommandId.make("c4"),
          threadId: asThreadId("t1"),
          reason: "no-sentinel",
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-paused");
      expect((event.payload as { reason: string }).reason).toBe("no-sentinel");
    }),
  );

  it.effect("complete emits finished/completed", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.complete",
          commandId: CommandId.make("c5"),
          threadId: asThreadId("t1"),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-finished");
      expect((event.payload as { outcome: string }).outcome).toBe("completed");
    }),
  );
});
```

- [ ] **Step 2: Run the test to confirm it fails.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/decider.unattendedRun.test.ts`
Expected: FAIL — `decideOrchestrationCommand` throws "Unknown command type" for the new commands.

- [ ] **Step 3: Implement the 7 cases.** Add inside the `switch (command.type)` in `decider.ts`, before the `default:` case. Use `nowIso` (already imported) for `occurredAt`/`updatedAt`. The helper `requireThread` returns the thread; read `thread.unattendedRun`.

```ts
    case "thread.unattended-run.start": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (thread.unattendedRun && (thread.unattendedRun.status === "running" || thread.unattendedRun.status === "paused")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has an active unattended run.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({ aggregateKind: "thread", aggregateId: command.threadId, occurredAt, commandId: command.commandId })),
        type: "thread.unattended-run-started",
        payload: { threadId: command.threadId, totalIterations: command.totalIterations, startedAt: occurredAt, updatedAt: occurredAt },
      };
    }
    case "thread.unattended-run.advance": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const run = thread.unattendedRun;
      if (!run || run.status !== "running") {
        return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: `Thread '${command.threadId}' has no running unattended run to advance.` });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({ aggregateKind: "thread", aggregateId: command.threadId, occurredAt, commandId: command.commandId })),
        type: "thread.unattended-run-iteration-advanced",
        payload: { threadId: command.threadId, iteration: run.currentIteration + 1, updatedAt: occurredAt },
      };
    }
    case "thread.unattended-run.pause": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const run = thread.unattendedRun;
      if (!run || run.status !== "running") {
        return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: `Thread '${command.threadId}' has no running unattended run to pause.` });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({ aggregateKind: "thread", aggregateId: command.threadId, occurredAt, commandId: command.commandId })),
        type: "thread.unattended-run-paused",
        payload: { threadId: command.threadId, reason: "manual", updatedAt: occurredAt },
      };
    }
    case "thread.unattended-run.fault": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const run = thread.unattendedRun;
      if (!run || run.status !== "running") {
        return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: `Thread '${command.threadId}' has no running unattended run to fault.` });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({ aggregateKind: "thread", aggregateId: command.threadId, occurredAt, commandId: command.commandId })),
        type: "thread.unattended-run-paused",
        payload: { threadId: command.threadId, reason: command.reason, updatedAt: occurredAt },
      };
    }
    case "thread.unattended-run.resume": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const run = thread.unattendedRun;
      if (!run || run.status !== "paused") {
        return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: `Thread '${command.threadId}' has no paused unattended run to resume.` });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({ aggregateKind: "thread", aggregateId: command.threadId, occurredAt, commandId: command.commandId })),
        type: "thread.unattended-run-resumed",
        payload: { threadId: command.threadId, updatedAt: occurredAt },
      };
    }
    case "thread.unattended-run.stop": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const run = thread.unattendedRun;
      if (!run || (run.status !== "running" && run.status !== "paused")) {
        return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: `Thread '${command.threadId}' has no active unattended run to stop.` });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({ aggregateKind: "thread", aggregateId: command.threadId, occurredAt, commandId: command.commandId })),
        type: "thread.unattended-run-finished",
        payload: { threadId: command.threadId, outcome: "stopped", iteration: run.currentIteration, updatedAt: occurredAt },
      };
    }
    case "thread.unattended-run.complete": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const run = thread.unattendedRun;
      if (!run || run.status !== "running") {
        return yield* new OrchestrationCommandInvariantError({ commandType: command.type, detail: `Thread '${command.threadId}' has no running unattended run to complete.` });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({ aggregateKind: "thread", aggregateId: command.threadId, occurredAt, commandId: command.commandId })),
        type: "thread.unattended-run-finished",
        payload: { threadId: command.threadId, outcome: "completed", iteration: run.currentIteration, updatedAt: occurredAt },
      };
    }
```

> If `decider.ts` uses `command.createdAt` instead of a `nowIso` effect in surrounding cases, follow whichever the file already does — check the `thread.session.set` case (it uses `command.createdAt`). Prefer `command.createdAt` for consistency if `nowIso` is not already imported; both compile.

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/decider.unattendedRun.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/orchestration/decider.ts apps/server/src/orchestration/decider.unattendedRun.test.ts
git commit -m "feat(server): decide unattended run commands into events"
```

---

## PHASE 4 — In-memory projector (event → read model)

### Task 9: Project unattended events into the in-memory read model

**Files:**

- Modify: `apps/server/src/orchestration/projector.ts`
- Test: `apps/server/src/orchestration/projector.test.ts` (add cases)

**Interfaces:**

- Consumes: `applyUnattendedRunEvent` from `@t3tools/shared/unattendedRun`.
- Produces: `thread.created` initializes `unattendedRun: null`; the 5 unattended events update it via the shared reducer.

- [ ] **Step 1: Write the failing test.** Append to `projector.test.ts`:

```ts
it("projects an unattended run lifecycle onto the thread", async () => {
  const now = "2026-01-01T00:00:00.000Z";
  let model = await Effect.runPromise(
    projectEvent(
      createEmptyReadModel(now),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: now,
        commandId: "cmd-create",
        payload: {
          threadId: "thread-1",
          projectId: "project-1",
          title: "demo",
          modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ),
  );
  expect(model.threads[0]?.unattendedRun).toBe(null);

  model = await Effect.runPromise(
    projectEvent(
      model,
      makeEvent({
        sequence: 2,
        type: "thread.unattended-run-started",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: now,
        commandId: null,
        payload: { threadId: "thread-1", totalIterations: 4, startedAt: now, updatedAt: now },
      }),
    ),
  );
  expect(model.threads[0]?.unattendedRun).toMatchObject({
    status: "running",
    totalIterations: 4,
    currentIteration: 1,
  });

  model = await Effect.runPromise(
    projectEvent(
      model,
      makeEvent({
        sequence: 3,
        type: "thread.unattended-run-paused",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: now,
        commandId: null,
        payload: { threadId: "thread-1", reason: "no-sentinel", updatedAt: now },
      }),
    ),
  );
  expect(model.threads[0]?.unattendedRun).toMatchObject({
    status: "paused",
    pauseReason: "no-sentinel",
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/projector.test.ts`
Expected: FAIL — `unattendedRun` is `undefined` (not initialized / not projected).

- [ ] **Step 3: Initialize the field in `thread.created`.** In the `case "thread.created":` builder, add `unattendedRun: null` to the new thread object (next to `session: null`).

- [ ] **Step 4: Add the 5 event cases.** Import the shared reducer at the top of `projector.ts`:

```ts
import { applyUnattendedRunEvent } from "@t3tools/shared/unattendedRun";
```

Add before the `default:` of the `projectEvent` switch. Each case folds via the shared reducer and writes through `updateThread`:

```ts
    case "thread.unattended-run-started":
    case "thread.unattended-run-iteration-advanced":
    case "thread.unattended-run-paused":
    case "thread.unattended-run-resumed":
    case "thread.unattended-run-finished":
      return Effect.succeed({
        ...nextBase,
        threads: updateThread(nextBase.threads, event.payload.threadId, {
          unattendedRun: applyUnattendedRunEvent(
            nextBase.threads.find((t) => t.id === event.payload.threadId)?.unattendedRun ?? null,
            event,
          ),
          updatedAt: event.occurredAt,
        }),
      });
```

- [ ] **Step 5: Run the test to confirm it passes.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/projector.test.ts`
Expected: PASS (including the existing `thread.created` test — it now asserts `unattendedRun: null`; update that existing assertion's expected object to include `unattendedRun: null` if it does an exact `toEqual`).

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/orchestration/projector.ts apps/server/src/orchestration/projector.test.ts
git commit -m "feat(server): project unattended run state in-memory"
```

---

## PHASE 5 — Persistence (survives restart)

### Task 10: Migration — add `unattended_run` column

**Files:**

- Create: `apps/server/src/persistence/Migrations/NNN_ProjectionThreadsUnattendedRun.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`

**Interfaces:**

- Produces: a nullable `unattended_run TEXT` column on `projection_threads`.

- [ ] **Step 1: Determine the next migration number.**

Run: `cd /home/chaz/projects/t3code && ls apps/server/src/persistence/Migrations/ | sort | tail -3`
Expected: highest existing `NNN_*.ts`. Use `NNN+1` (zero-padded to 3 digits) below.

- [ ] **Step 2: Create the migration** mirroring `017_ProjectionThreadsArchivedAt.ts` exactly (idempotent PRAGMA check + ALTER TABLE):

```ts
// Migrations/NNN_ProjectionThreadsUnattendedRun.ts
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (columns.some((column) => column.name === "unattended_run")) {
    return;
  }
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN unattended_run TEXT
  `;
});
```

> Open `017_ProjectionThreadsArchivedAt.ts` and copy its exact import paths/structure — match it verbatim apart from the column name.

- [ ] **Step 3: Register it** in `Migrations.ts`: add the static import next to the others and the `[NNN, "ProjectionThreadsUnattendedRun", MigrationNNN]` entry in the `migrationEntries` array (match the exact tuple/record shape used there).

- [ ] **Step 4: Typecheck.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp run typecheck`
Expected: PASS for the migration files (snapshot/repo edits come next).

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/persistence/Migrations/ apps/server/src/persistence/Migrations.ts
git commit -m "feat(server): migration adds projection_threads.unattended_run"
```

### Task 11: Persist & read `unattendedRun` through the thread row

**Files:**

- Modify: `apps/server/src/persistence/Services/ProjectionThreads.ts`
- Modify: `apps/server/src/persistence/Layers/ProjectionThreads.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`

**Interfaces:**

- Consumes: `applyUnattendedRunEvent` from `@t3tools/shared/unattendedRun`, `UnattendedRunState` from contracts.
- Produces: the `unattended_run` column round-trips into `OrchestrationThread.unattendedRun` from both `getSnapshot` and `getThreadDetailById`.

- [ ] **Step 1: Row schema field.** In `persistence/Services/ProjectionThreads.ts`, add to the `ProjectionThread` struct (next to `deletedAt`), using contracts' `UnattendedRunState`:

```ts
  unattendedRun: Schema.NullOr(UnattendedRunState),
```

Import `UnattendedRunState` from `@t3tools/contracts`. The snapshot path decodes the JSON column, so also confirm the snapshot's `ProjectionThreadDbRowSchema` (`ProjectionSnapshotQuery.ts:77`) maps it — see Step 4.

- [ ] **Step 2: Repository upsert + select.** In `persistence/Layers/ProjectionThreads.ts`:
  - In the INSERT column list add `unattended_run`, in VALUES add `${row.unattendedRun === null ? null : JSON.stringify(row.unattendedRun)}`, and in `ON CONFLICT ... DO UPDATE SET` add `unattended_run = excluded.unattended_run`.
  - In the `getById` and `listByProjectId` SELECTs add `unattended_run AS "unattendedRun"`.
  - The `Result` schema for selects must decode the JSON string → `UnattendedRunState | null`. Mirror how `model_selection_json` is handled. If selects use a DB-row schema with `Schema.fromJsonString`, add `unattendedRun: Schema.NullOr(Schema.fromJsonString(UnattendedRunState))`; if they decode via the plain `ProjectionThread` schema, change that field to `Schema.NullOr(Schema.fromJsonString(UnattendedRunState))` in the DB-row variant only (not the write model). Match the existing `modelSelection` treatment exactly.

- [ ] **Step 3: ProjectionPipeline writes.** In `ProjectionPipeline.ts` `applyThreadsProjection`:
  - In `case "thread.created":` upsert add `unattendedRun: null`.
  - Add a combined case for the five unattended events that recomputes the column from the existing row via the shared reducer:

```ts
    case "thread.unattended-run-started":
    case "thread.unattended-run-iteration-advanced":
    case "thread.unattended-run-paused":
    case "thread.unattended-run-resumed":
    case "thread.unattended-run-finished": {
      const existingRow = yield* projectionThreadRepository.getById({ threadId: event.payload.threadId });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        unattendedRun: applyUnattendedRunEvent(existingRow.value.unattendedRun, event),
        updatedAt: event.occurredAt,
      });
      yield* refreshThreadShellSummary(event.payload.threadId);
      return;
    }
```

Import `applyUnattendedRunEvent` at the top of `ProjectionPipeline.ts`.

- [ ] **Step 4: Snapshot assembly (both sites).** In `ProjectionSnapshotQuery.ts`:
  - Add `unattended_run AS "unattendedRun"` to every `projection_threads` SELECT (`listThreadRows` ~line 318 and `getActiveThreadRowById` ~line 738). The shared `ProjectionThreadDbRowSchema` (line 77) inherits the field from `ProjectionThread`; if `unattendedRun` is stored as JSON it must be decoded there — extend the `mapFields(Struct.assign({...}))` to include `unattendedRun: Schema.NullOr(Schema.fromJsonString(UnattendedRunState))`, mirroring `modelSelection`.
  - In the `getSnapshot` assembly (`threadRows.map((row) => ({...}))`, ~line 1175) add `unattendedRun: row.unattendedRun,`.
  - In the `getThreadDetailById` assembly object (~line 1970) add `unattendedRun: threadRow.value.unattendedRun,`.

- [ ] **Step 5: Typecheck the server.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp run typecheck`
Expected: PASS (all `OrchestrationThread` construction sites now provide `unattendedRun`).

- [ ] **Step 6: Add a persistence round-trip test.** Append to the existing ProjectionPipeline/snapshot test suite (find it with `ls apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`). Dispatch `thread.created` + `thread.unattended-run-started` through the engine, then assert `getThreadDetailById` returns `unattendedRun.status === "running"`. Model setup on `ProviderCommandReactor.test.ts`'s harness layer composition (the `orchestrationLayer` + `SqlitePersistenceMemory`).

- [ ] **Step 7: Run the persistence test.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/Layers/ProjectionPipeline.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/server/src/persistence apps/server/src/orchestration/Layers/ProjectionPipeline.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts
git commit -m "feat(server): persist unattended run state on projection_threads"
```

---

## PHASE 6 — The reactor (the loop)

### Task 12: UnattendedRunReactor — service + skeleton wiring

**Files:**

- Create: `apps/server/src/orchestration/Services/UnattendedRunReactor.ts`
- Create: `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`
- Modify: `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Produces: `UnattendedRunReactor` Service tag with `{ start(): Effect<void, never, Scope>; drain: Effect<void> }`, and `UnattendedRunReactorLive` layer. Subscribes to `orchestrationEngine.streamDomainEvents`; processes via a `makeDrainableWorker`.

- [ ] **Step 1: Service definition** — mirror `Services/ThreadDeletionReactor.ts`:

```ts
// Services/UnattendedRunReactor.ts
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface UnattendedRunReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class UnattendedRunReactor extends Context.Service<
  UnattendedRunReactor,
  UnattendedRunReactorShape
>()("t3/orchestration/Services/UnattendedRunReactor") {}
```

- [ ] **Step 2: Layer skeleton** — dependencies + empty worker that no-ops, so wiring compiles before logic lands. Mirror `Layers/ThreadDeletionReactor.ts`:

```ts
// Layers/UnattendedRunReactor.ts
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  UnattendedRunReactor,
  type UnattendedRunReactorShape,
} from "../Services/UnattendedRunReactor.ts";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  // Per-thread accumulator of the latest assistant text (reset at turn start).
  const latestAssistantText = new Map<string, string>();

  const processEvent = (_event: OrchestrationEvent) => Effect.void; // filled in Task 13

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("unattended run reactor failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const start: UnattendedRunReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => worker.enqueue(event)),
    );
  });

  return { start, drain: worker.drain } satisfies UnattendedRunReactorShape;
});

export const UnattendedRunReactorLive = Layer.effect(UnattendedRunReactor, make);

// Re-exported for unit testing pure helpers added in Task 13.
export const __test = {
  /* populated in Task 13 */
};
```

- [ ] **Step 3: Wire into `OrchestrationReactor`.** In `Layers/OrchestrationReactor.ts` add `const unattendedRunReactor = yield* UnattendedRunReactor;` and `yield* unattendedRunReactor.start();` inside `start`, plus the import.

- [ ] **Step 4: Register the layer in `server.ts`.** Add `Layer.provideMerge(UnattendedRunReactorLive)` to `ReactorLayerLive` and import it.

- [ ] **Step 5: Typecheck.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/orchestration/Services/UnattendedRunReactor.ts apps/server/src/orchestration/Layers/UnattendedRunReactor.ts apps/server/src/orchestration/Layers/OrchestrationReactor.ts apps/server/src/server.ts
git commit -m "feat(server): scaffold UnattendedRunReactor and wire it in"
```

### Task 13: Reactor loop logic

**Files:**

- Modify: `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`
- Test: `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`

**Interfaces:**

- Consumes: `messageHasWrapSentinel`, `buildUnattendedPreamble`, `CONTINUE_MESSAGE` from `../unattendedRun.ts`; `MessageId` from contracts; `ProjectionSnapshotQuery.getThreadDetailById`; `orchestrationEngine.dispatch`.
- Produces: the full state machine described below.

**Loop rules (implement exactly):**

1. `thread.turn-start-requested` → `latestAssistantText.set(threadId, "")`.
2. `thread.message-sent` with `role === "assistant"` → append `payload.text` to `latestAssistantText[threadId]`.
3. `thread.unattended-run-started` → read thread (snapshot), dispatch a `thread.turn.start` whose message text is `buildUnattendedPreamble(totalIterations)`, with a fresh `MessageId`, passing the thread's `runtimeMode`/`interactionMode`.
4. `thread.session-set` → only act when the thread has `unattendedRun.status === "running"`. Let `status = payload.session.status`:
   - `status === "error"` → dispatch `thread.unattended-run.fault` reason `"error"`.
   - `status === "idle" || status === "ready"` (a real turn end): let `text = latestAssistantText[threadId] ?? ""`.
     - `messageHasWrapSentinel(text)` true:
       - if `currentIteration < totalIterations` → run the **clear+continue** sequence (below).
       - else → dispatch `thread.unattended-run.complete`.
     - false → dispatch `thread.unattended-run.fault` reason `"no-sentinel"`.
   - any other status (`running`, `starting`, `stopped`, `interrupted`) → ignore. (This is what prevents our own `session.stop`/the user's interrupt from being read as a turn end.)
5. `thread.turn-interrupt-requested` → if `unattendedRun.status === "running"`, dispatch `thread.unattended-run.pause` (manual).
6. `thread.unattended-run-resumed` → read thread; if the session is not currently `running`, dispatch a `thread.turn.start` with `CONTINUE_MESSAGE` to re-arm the loop.

**clear+continue sequence (helper):** dispatch `thread.session.stop`; poll `getThreadDetailById` until `session === null || session.status === "stopped"` (bounded: ~20 tries with a short `Effect.sleep`); then dispatch `thread.unattended-run.advance`, then dispatch a `thread.turn.start` with `CONTINUE_MESSAGE`. If the stop never settles or any dispatch fails, dispatch `thread.unattended-run.fault` reason `"error"`.

- [ ] **Step 1: Extract a pure decision helper and unit-test it.** Add an exported pure function that maps `(status, hasSentinel, currentIteration, totalIterations)` to an action tag, so the core branching is tested without the Effect runtime:

```ts
export type TurnEndAction =
  | { readonly kind: "fault"; readonly reason: "error" | "no-sentinel" }
  | { readonly kind: "complete" }
  | { readonly kind: "clear-continue" }
  | { readonly kind: "ignore" };

export const decideTurnEndAction = (input: {
  readonly status: string;
  readonly hasSentinel: boolean;
  readonly currentIteration: number;
  readonly totalIterations: number;
}): TurnEndAction => {
  if (input.status === "error") return { kind: "fault", reason: "error" };
  if (input.status !== "idle" && input.status !== "ready") return { kind: "ignore" };
  if (!input.hasSentinel) return { kind: "fault", reason: "no-sentinel" };
  return input.currentIteration < input.totalIterations
    ? { kind: "clear-continue" }
    : { kind: "complete" };
};
```

Write `UnattendedRunReactor.test.ts` with a `describe("decideTurnEndAction")` block asserting: error→fault/error; running→ignore; stopped→ignore; interrupted→ignore; idle+sentinel+mid→clear-continue; idle+sentinel+last→complete; idle+no-sentinel→fault/no-sentinel.

- [ ] **Step 2: Run the pure test to confirm it fails.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts`
Expected: FAIL — `decideTurnEndAction` not exported.

- [ ] **Step 3: Implement `decideTurnEndAction` + the full `processEvent`.** Replace the placeholder `processEvent` with a `switch (event.type)` implementing rules 1-6, using `decideTurnEndAction` for the `thread.session-set` branch. Use `serverCommandId(tag)` + `orchestrationEngine.dispatch({...})` for every command; generate message ids with `MessageId.make(\`unattended:${uuid}\`)`via`crypto.randomUUIDv4`. Read the thread via `projectionSnapshotQuery.getThreadDetailById(threadId)`(returns`Option<OrchestrationThread>`; use `Option.getOrUndefined`). Populate the exported `\_\_test`object with`{ decideTurnEndAction }`.

- [ ] **Step 4: Run the pure test to confirm it passes.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts`
Expected: PASS (7 assertions).

- [ ] **Step 5: Add an integration test** using a harness modeled on `ProviderCommandReactor.test.ts` (same layer stack: `OrchestrationEngineLive` + `SqlitePersistenceMemory` + a mocked `ProviderService`, plus `UnattendedRunReactorLive`). Drive it by dispatching events through the engine and asserting issued commands land as new events / read-model state. Cover at minimum:
  - After `thread.unattended-run.start` (total 2), the reactor issues a `thread.turn.start` (assert a user message with the preamble text appears, or the mocked provider `sendTurn`/`startSession` is called).
  - Simulate a turn end **with** sentinel: dispatch an assistant `thread.message-sent` containing `WRAP_SENTINEL`, then a `thread.session.set` with `status: "idle"`. Drain. Assert the read model shows `unattendedRun.currentIteration === 2` (advanced) and a new continue turn was started.
  - Simulate a turn end **without** sentinel: assistant message without the sentinel + `session.set` idle. Drain. Assert `unattendedRun.status === "paused"`, `pauseReason === "no-sentinel"`.
  - After reaching the last iteration with sentinel, assert `unattendedRun.status === "completed"`.

  Use `harness.drain()` (the reactor's `drain`) between steps instead of sleeps. To set session state in tests, dispatch `thread.session.set` commands with a hand-built `OrchestrationSession` (see how `ProviderCommandReactor.test.ts` constructs sessions), since the mocked provider won't emit real runtime events.

- [ ] **Step 6: Run the integration test.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/server/src/orchestration/Layers/UnattendedRunReactor.ts apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts
git commit -m "feat(server): unattended run reactor loop (sentinel -> clear -> continue)"
```

### Task 14: Rehydrate active runs on startup

**Files:**

- Modify: `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`
- Test: `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts` (add case)

**Interfaces:**

- Produces: on `start()`, before subscribing, the reactor reads the snapshot and, for each thread with `unattendedRun.status === "running"` whose session is not currently `running`, dispatches a `CONTINUE_MESSAGE` turn to resume the current iteration. (`streamDomainEvents` is new-events-only, so without this a run silently stalls after a restart.)

- [ ] **Step 1: Write the failing test.** Build a harness where the persisted read model already has a thread with `unattendedRun.status === "running"` and an idle session (dispatch the events, then create a _fresh_ reactor instance against the same persistence and call `start()`). Assert a continue turn is issued on start. (If reusing one runtime is simpler, assert that calling `start()` with a pre-seeded running run triggers a `thread.turn.start`.)

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts`
Expected: FAIL — no resume turn issued on start.

- [ ] **Step 3: Implement rehydration** at the top of `start`, before `Effect.forkScoped(...)`:

```ts
const snapshot = yield * projectionSnapshotQuery.getSnapshot();
yield *
  Effect.forEach(
    snapshot.threads.filter(
      (t) => t.unattendedRun?.status === "running" && t.session?.status !== "running",
    ),
    (thread) => issueContinueTurn(thread),
    { concurrency: 1, discard: true },
  );
```

where `issueContinueTurn(thread)` is the same helper used by rule 6 (resume). Guard against double-issue by only resuming threads whose session is not `running`.

- [ ] **Step 4: Run it to confirm it passes.**

Run: `cd /home/chaz/projects/t3code/apps/server && vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/orchestration/Layers/UnattendedRunReactor.ts apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts
git commit -m "feat(server): rehydrate active unattended runs on startup"
```

### Task 15: Full server check

- [ ] **Step 1: Run the whole server check.**

Run: `cd /home/chaz/projects/t3code && vp check && vp run typecheck`
Expected: PASS. Fix any fallout (e.g. exhaustiveness `satisfies never` in decider/projector, or fixtures missing `unattendedRun`). Re-run until green.

- [ ] **Step 2: Commit any fixups.**

```bash
git add -A
git commit -m "chore(server): green check after unattended run server work"
```

---

## PHASE 7 — Web state & command senders

### Task 16: Web Thread type + store reducers

**Files:**

- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/store.ts`
- Test: `apps/web/src/store.unattendedRun.test.ts` (new) — if the store has no existing test, add one; otherwise append to the existing store test.

**Interfaces:**

- Consumes: `applyUnattendedRunEvent` from `@t3tools/shared/unattendedRun`, `UnattendedRunState` from `@t3tools/contracts`.
- Produces: `Thread.unattendedRun: UnattendedRunState | null`; the store folds the 5 events.

- [ ] **Step 1: Write the failing test.** Reduce a `thread.unattended-run-started` event into a seeded thread and assert `thread.unattendedRun.status === "running"`. (Model on how the store is exercised elsewhere; if the store reducer isn't directly exported, test through the public dispatch used by other store tests.)

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cd /home/chaz/projects/t3code/apps/web && vp test run src/store.unattendedRun.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the type field.** In `types.ts` `Thread` interface add:

```ts
unattendedRun: UnattendedRunState | null;
```

Import `UnattendedRunState` from `@t3tools/contracts`. Initialize it to `null` wherever a `Thread` is constructed from a `thread.created`/snapshot (search `store.ts` for the thread-created reducer and the snapshot hydration; set `unattendedRun: thread.unattendedRun ?? null`).

- [ ] **Step 4: Add the 5 reducer cases** in `applyEnvironmentOrchestrationEvent` (after `thread.session-stop-requested`, ~line 1552):

```ts
    case "thread.unattended-run-started":
    case "thread.unattended-run-iteration-advanced":
    case "thread.unattended-run-paused":
    case "thread.unattended-run-resumed":
    case "thread.unattended-run-finished":
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        unattendedRun: applyUnattendedRunEvent(thread.unattendedRun, event),
        updatedAt: event.occurredAt,
      }));
```

Import `applyUnattendedRunEvent` at the top of `store.ts`.

- [ ] **Step 5: Run it to confirm it passes.**

Run: `cd /home/chaz/projects/t3code/apps/web && vp test run src/store.unattendedRun.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/types.ts apps/web/src/store.ts apps/web/src/store.unattendedRun.test.ts
git commit -m "feat(web): track unattended run state in the store"
```

### Task 17: Web command senders

**Files:**

- Modify: `apps/web/src/hooks/useThreadActions.ts` (or the nearest existing hook that already sends `thread.session.stop` — keep them together)

**Interfaces:**

- Produces: `startUnattendedRun(threadRef, totalIterations)`, `pauseUnattendedRun(threadRef)`, `resumeUnattendedRun(threadRef)`, `stopUnattendedRun(threadRef)`, each calling `api.orchestration.dispatchCommand` with `newCommandId()` and `new Date().toISOString()`, mirroring the existing `thread.session.stop` sender.

- [ ] **Step 1: Implement the four senders** next to the existing session-stop sender:

```ts
const startUnattendedRun = useCallback(
  async (totalIterations: number) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unattended-run.start",
      commandId: newCommandId(),
      threadId: threadRef.threadId,
      totalIterations,
      createdAt: new Date().toISOString(),
    });
  },
  [environmentId, threadRef.threadId],
);
// pause / resume / stop identical but with their type strings and no totalIterations
```

- [ ] **Step 2: Typecheck web.**

Run: `cd /home/chaz/projects/t3code/apps/web && vp run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add apps/web/src/hooks/useThreadActions.ts
git commit -m "feat(web): dispatch unattended run commands"
```

---

## PHASE 8 — Web UI

### Task 18: Start dialog

**Files:**

- Create: `apps/web/src/components/chat/UnattendedRunDialog.tsx`

**Interfaces:**

- Produces: `UnattendedRunDialog({ open, onOpenChange, onConfirm })` where `onConfirm(totalIterations: number)`. Uses `AlertDialog` + `NumberField` (min 1, max `UNATTENDED_RUN_MAX_ITERATIONS`), defaulting to a sensible value (e.g. 5). Shows a short note that the agent must end each wrap with the sentinel.

- [ ] **Step 1: Implement the dialog** using the `AlertDialog` + `NumberField` template (see `ProjectScriptsControl.tsx` for dialog usage and `ui/number-field.tsx` for the input). Clamp the value to `[1, UNATTENDED_RUN_MAX_ITERATIONS]` before calling `onConfirm`.

- [ ] **Step 2: Typecheck web.**

Run: `cd /home/chaz/projects/t3code/apps/web && vp run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add apps/web/src/components/chat/UnattendedRunDialog.tsx
git commit -m "feat(web): unattended run start dialog"
```

### Task 19: Menu item to open the dialog

**Files:**

- Modify: `apps/web/src/components/chat/CompactComposerControlsMenu.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`

**Interfaces:**

- Consumes: a new `onStartUnattendedRun: () => void` prop + a `canStartUnattendedRun: boolean` prop on `CompactComposerControlsMenu`.
- Produces: a "Start unattended run…" `MenuItem`, disabled when a run is already active or a turn is running.

- [ ] **Step 1: Add the props + MenuItem.** In `CompactComposerControlsMenu.tsx` add the two props and render (before the closing `MenuPopup`):

```tsx
<MenuDivider />
<MenuItem onClick={props.onStartUnattendedRun} disabled={!props.canStartUnattendedRun}>
  <PlayIcon className="size-4 shrink-0" />
  Start unattended run…
</MenuItem>
```

Import `PlayIcon` from `lucide-react` and `MenuDivider` if not already imported.

- [ ] **Step 2: Wire from `ChatComposer.tsx`.** Pass `onStartUnattendedRun={() => setUnattendedDialogOpen(true)}` and `canStartUnattendedRun={!activeThread?.unattendedRun || activeThread.unattendedRun.status === "completed" || activeThread.unattendedRun.status === "stopped"}` (and not currently running a turn — reuse the existing `isRunning` signal if available at this level; otherwise compute from `activeThread.session?.status`).

- [ ] **Step 3: Typecheck web.**

Run: `cd /home/chaz/projects/t3code/apps/web && vp run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/web/src/components/chat/CompactComposerControlsMenu.tsx apps/web/src/components/chat/ChatComposer.tsx
git commit -m "feat(web): start-unattended-run menu item"
```

### Task 20: Status banner + dialog mount + handlers

**Files:**

- Create: `apps/web/src/components/chat/unattendedRunBanner.ts`
- Test: `apps/web/src/components/chat/unattendedRunBanner.test.ts`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**

- Produces: `buildUnattendedRunBannerItem(input: { run: UnattendedRunState; onPause; onResume; onStop }): ComposerBannerStackItem | null` — a pure builder returning the banner item (variant `info` when running, `warning` when paused) or `null` when the run is terminal/absent.

- [ ] **Step 1: Write the failing test** for the pure builder:

```ts
// apps/web/src/components/chat/unattendedRunBanner.test.ts
import { describe, expect, it } from "vite-plus/test";
import { buildUnattendedRunBannerItem } from "./unattendedRunBanner.ts";

const noop = () => {};
const handlers = { onPause: noop, onResume: noop, onStop: noop };

describe("buildUnattendedRunBannerItem", () => {
  it("returns an info banner while running", () => {
    const item = buildUnattendedRunBannerItem({
      run: {
        status: "running",
        totalIterations: 3,
        currentIteration: 2,
        pauseReason: null,
        startedAt: "x",
        updatedAt: "x",
      },
      ...handlers,
    });
    expect(item?.variant).toBe("info");
  });
  it("returns a warning banner when paused", () => {
    const item = buildUnattendedRunBannerItem({
      run: {
        status: "paused",
        totalIterations: 3,
        currentIteration: 2,
        pauseReason: "no-sentinel",
        startedAt: "x",
        updatedAt: "x",
      },
      ...handlers,
    });
    expect(item?.variant).toBe("warning");
  });
  it("returns null for terminal runs", () => {
    expect(
      buildUnattendedRunBannerItem({
        run: {
          status: "completed",
          totalIterations: 3,
          currentIteration: 3,
          pauseReason: null,
          startedAt: "x",
          updatedAt: "x",
        },
        ...handlers,
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `cd /home/chaz/projects/t3code/apps/web && vp test run src/components/chat/unattendedRunBanner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder** returning a `ComposerBannerStackItem` (import the type from `./ComposerBannerStack`). Title `Unattended run · iteration {currentIteration} of {totalIterations} · {status}`; when paused, description explains the reason (`no-sentinel` → "agent stopped without wrapping — it may be asking a question"). `actions` render Pause (running) / Resume (paused) / Stop buttons via `onPause`/`onResume`/`onStop`. Return `null` when `status` is `completed`/`stopped`. (This file is `.ts`; build `actions`/`icon` as React elements with `createElement`, or rename to `.tsx` if you prefer JSX — keep the test importing the same path.)

- [ ] **Step 4: Run it to confirm it passes.**

Run: `cd /home/chaz/projects/t3code/apps/web && vp test run src/components/chat/unattendedRunBanner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Mount in `ChatView.tsx`.**
  - Add `const [unattendedDialogOpen, setUnattendedDialogOpen] = useState(false);`.
  - Render `<UnattendedRunDialog open={unattendedDialogOpen} onOpenChange={setUnattendedDialogOpen} onConfirm={(n) => { void startUnattendedRun(n); setUnattendedDialogOpen(false); }} />`.
  - In the `composerBannerItems` useMemo, push `buildUnattendedRunBannerItem({ run, onPause: () => void pauseUnattendedRun(...), onResume: () => void resumeUnattendedRun(...), onStop: () => void stopUnattendedRun(...) })` when `activeThread?.unattendedRun` is set and the builder returns non-null.
  - Wire `startUnattendedRun`/`pause`/`resume`/`stop` from Task 17's hook.

- [ ] **Step 6: Typecheck + web check.**

Run: `cd /home/chaz/projects/t3code/apps/web && vp run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/components/chat/unattendedRunBanner.ts apps/web/src/components/chat/unattendedRunBanner.test.ts apps/web/src/components/ChatView.tsx
git commit -m "feat(web): unattended run banner, dialog mount, and controls"
```

### Task 21: Final full check

- [ ] **Step 1: Run the entire check + typecheck + tests.**

Run: `cd /home/chaz/projects/t3code && vp check && vp run typecheck && vp test run`
Expected: PASS across server, web, shared, contracts. Fix any fallout and re-run until green.

- [ ] **Step 2: Manual smoke (optional but recommended).** Start the app, open a thread, "Start unattended run…", pick 2 iterations, and confirm: the preamble turn starts; ending a turn with `<<WRAP_COMPLETE>>` triggers a context clear + continue; the banner tracks `iteration k of N`; removing the sentinel pauses the run with the amber banner; Pause/Resume/Stop behave.

- [ ] **Step 3: Commit any fixups.**

```bash
git add -A
git commit -m "chore: green full check for unattended runs"
```

---

## Self-Review Notes (coverage vs spec)

- Spec §3 decisions (sentinel detection, pause-on-no-sentinel, server event-sourced reactor, within-thread clear) → Tasks 7, 13 (`decideTurnEndAction`, clear+continue), 8, 12-14.
- Spec §4.1 events / §4.2 commands → Tasks 3, 4. §4.3 read model → Tasks 2, 9, 11. §4.4 reactor incl. clear-before-continue + error→pause → Task 13. Rehydration (§7 reconnect/restart) → Task 14.
- Spec §5 prompts/sentinel constants → Task 7. §6 UI (start dialog, banner, interrupt-pauses, paused explanation) → Tasks 18-20; interrupt→pause is rule 5 in Task 13 plus the manual pause path. §7 edge cases (one-run-per-thread, count bounds, manual takeover) → Task 8 invariants + `UnattendedRunIterations` bound (Task 1) + manual-pause (Task 13 rule 5).
- Spec §8 testing → tests in Tasks 6, 7, 8, 9, 11, 13, 14, 16, 20.
