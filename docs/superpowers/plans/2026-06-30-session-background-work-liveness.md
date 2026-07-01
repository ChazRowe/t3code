# Session Background-Work Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a session visibly "live" (a distinct cyan pulsing "Background" pill in the sidebar + an in-view banner with a wait timer) and protected from the idle reaper whenever it has launched non-blocking background work (background Bash, backgrounded Task subagent, Workflow, MCP monitor, or cross-provider `spawn_agent`) that outlives the turn — until **all** of that work completes.

**Architecture:** A single in-memory `BackgroundWorkLedger` server service (keyed by `threadId`, `Ref`-backed state + `PubSub` change signal) is fed by two terminal-reliable feeders — the unified native `task.started`/`task.completed` runtime-event stream, and the `spawn_agent` jobs map — and read by two consumers: the status projection (adds a nullable `backgroundWork` field to `OrchestrationSession`) and the idle reaper (replaces the Workflows-only `hasPendingBackgroundWork` check). The web layer renders a new pill + banner from the projected field. Turn-settling semantics are unchanged; background-pending is a field layered on top of a settled turn.

**Tech Stack:** TypeScript, **`effect-smol`** (the vendored `effect`), `vite-plus/test` (vitest-compatible), React (web), pnpm workspaces.

## Global Constraints

- **Framework is `effect-smol`.** There is **no `SubscriptionRef`** in `apps/server/src`. The house pattern for "hold state + expose a changes stream" is **`Ref` for state + `PubSub` for the change signal**, with the stream exposed via `Stream.fromPubSub` (and a synchronous `PubSub.subscribe` for consumers/tests that must not miss a publish). Template: `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts` + `apps/server/src/provider/Services/ProviderInstanceRegistry.ts`.
- **Service-tag idiom:** `export class X extends Context.Service<X, XShape>()("t3/<area>/Services/<Name>") {}`. Consumers access via `const x = yield* X;`. Do **not** use `Context.GenericTag`, `Effect.Service`, or `Context.Tag`.
- **The `BackgroundWorkLedger` is a SINGLE shared instance.** It is provided exactly once (in `OrchestrationLayerLive`). Never `Layer.provide(BackgroundWorkLedgerLive)` privately inside a consumer layer — that would build a *second* instance and the reaper, ingestion, and spawn feeders would disagree.
- **Contract field is `Schema.optional(Schema.NullOr(...))`** (a deliberate refinement of the design's `Schema.NullOr`): optional so pre-existing persisted/replayed `thread.session-set` events that lack the field still decode, and so existing `OrchestrationSession` construction/fixture sites do not all have to be touched. Semantics are unchanged (`null`/absent = no pending work; the UI tests `!= null`).
- **Node 24 is required for tests and typecheck.** The default harness shell is Node v23.9.0, which crashes the test runner. Before running any `pnpm test` / `pnpm typecheck`, put Node 24 on `PATH`:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
  node -v   # must print v24.x
  ```
- **Package names & commands** (run from repo root `/home/chaz/projects/t3code`):
  - server = `t3`; contracts = `@t3tools/contracts`; web = `@t3tools/web`.
  - Run one test file: `pnpm --filter <pkg> test <relative/path.test.ts>` (the `test` script is `vp test run`, so the path is appended as a filter). Filter by name with ` -t "<name>"`.
  - Typecheck a package: `pnpm --filter <pkg> typecheck` (runs `tsgo --noEmit`). Whole repo: `pnpm tc`.
- **Test imports come from `"vite-plus/test"`** (`import { describe, expect, it, vi, afterEach } from "vite-plus/test";`), not `vitest`.
- Commit after every task. DRY, YAGNI, TDD.

---

## File Structure

**New files:**
- `apps/server/src/orchestration/Services/BackgroundWorkLedger.ts` — service tag + shape + entry/snapshot types. One responsibility: the ledger's public contract.
- `apps/server/src/orchestration/Layers/BackgroundWorkLedger.ts` — the in-memory implementation (Ref + PubSub + backstop sweep fiber) and its layer.
- `apps/server/src/orchestration/Layers/BackgroundWorkLedger.test.ts` — ledger unit tests.

**Modified files (server):**
- `packages/contracts/src/orchestration.ts` — add `OrchestrationSession.backgroundWork`.
- `packages/contracts/src/orchestration.test.ts` — decode tests for the new field.
- `apps/server/src/orchestration/runtimeLayer.ts` — wire `BackgroundWorkLedgerLive` into `OrchestrationLayerLive` (the single shared provide point).
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — native-task feeder (register/unregister), `clearThread` on `session.exited`, `backgroundWork` projection into the two `thread.session.set` dispatches, and the `ledger.changes` between-turns push fiber.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` — feeder + projection tests.
- `apps/server/src/mcp/toolkits/spawn/handlers.ts` — spawn feeder (register in `putJob`, unregister when a job goes terminal in `patchJob`).
- `apps/server/src/mcp/toolkits/spawn/handlers.test.ts` — spawn deps + feeder test.
- `apps/server/src/mcp/McpHttpServer.ts` — inject the ledger into `makeSpawnAgentHandlers`.
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` — read `ledger.snapshotFor` instead of `hasPendingBackgroundWork`.
- `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts` — update the harness to a real ledger; add spawn-kind + becomes-eligible cases.
- `apps/server/src/provider/Services/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/provider/Services/ProviderAdapter.ts`, `apps/server/src/provider/Layers/ClaudeAdapter.ts` — **remove** `hasPendingBackgroundWork`.

**Modified files (web):**
- `apps/web/src/types.ts` — add `backgroundWork` to `ThreadSession`.
- `apps/web/src/store.ts` — map `backgroundWork` in `mapSession`.
- `apps/web/src/components/Sidebar.logic.ts` — new "Background" pill branch + priority.
- `apps/web/src/components/Sidebar.logic.test.ts` — pill precedence tests.
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` — `kind:"background"` row + derive input.
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` — derive tests.
- `apps/web/src/components/chat/MessagesTimeline.tsx` — `BackgroundTimelineRow` + prop + dispatch case.
- `apps/web/src/components/ChatView.tsx` — pass `backgroundWork` into `<MessagesTimeline>`.

---

## Task 1: Contract — `OrchestrationSession.backgroundWork`

**Files:**
- Modify: `packages/contracts/src/orchestration.ts:306-316` (the `OrchestrationSession` struct)
- Test: `packages/contracts/src/orchestration.test.ts`

**Interfaces:**
- Produces: `OrchestrationSession.backgroundWork` — decoded TS type `{ count: number; oldestStartedAt: string } | null | undefined`. Rides `ThreadSessionSetPayload` (`orchestration.ts:1107-1109`) automatically. Consumed by Task 4 (server projection), Task 6/7 (web `mapSession`), Task 5 reaper (indirectly).

- [ ] **Step 1: Write the failing test**

In `packages/contracts/src/orchestration.test.ts`, mirror the file's existing decode idiom (it already imports `OrchestrationSession` region schemas and `effect/Schema`). Add:

```ts
describe("OrchestrationSession.backgroundWork", () => {
  const base = {
    threadId: "thread-1",
    status: "ready",
    providerName: "claudeAgent",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-06-30T00:00:00.000Z",
  } as const;

  it("decodes a session that carries pending background work", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationSession)({
      ...base,
      backgroundWork: { count: 2, oldestStartedAt: "2026-06-30T00:00:00.000Z" },
    });
    expect(decoded.backgroundWork).toEqual({
      count: 2,
      oldestStartedAt: "2026-06-30T00:00:00.000Z",
    });
  });

  it("treats an omitted backgroundWork as no pending work", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationSession)(base);
    expect(decoded.backgroundWork ?? null).toBeNull();
  });

  it("accepts an explicit null backgroundWork", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationSession)({
      ...base,
      backgroundWork: null,
    });
    expect(decoded.backgroundWork).toBeNull();
  });
});
```

Ensure the top of the file imports `Schema` (`import * as Schema from "effect/Schema";`) and `OrchestrationSession` from `./orchestration.ts` — add them if absent. (If `Schema.decodeUnknownSync` is not exported in this `effect-smol` build, use the file's existing decode helper — e.g. `Schema.decodeSync`.)

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter @t3tools/contracts test src/orchestration.test.ts -t "backgroundWork"
```
Expected: FAIL — `backgroundWork` is not a known property (decode drops it / assertion fails).

- [ ] **Step 3: Add the schema field**

In `packages/contracts/src/orchestration.ts`, add `backgroundWork` to the `OrchestrationSession` struct (between `lastError` and `updatedAt`):

```ts
export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  backgroundWork: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        count: Schema.Number,
        oldestStartedAt: IsoDateTime,
      }),
    ),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;
```

`IsoDateTime`, `Schema`, and `Effect` are already imported in this file (used by the surrounding fields). `Schema.Number` is standard.

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter @t3tools/contracts test src/orchestration.test.ts -t "backgroundWork"
pnpm --filter @t3tools/contracts typecheck
```
Expected: PASS (3 tests) and clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts
git commit -m "feat(contracts): add OrchestrationSession.backgroundWork field"
```

---

## Task 2: `BackgroundWorkLedger` service + layer (+ wiring)

**Files:**
- Create: `apps/server/src/orchestration/Services/BackgroundWorkLedger.ts`
- Create: `apps/server/src/orchestration/Layers/BackgroundWorkLedger.ts`
- Create: `apps/server/src/orchestration/Layers/BackgroundWorkLedger.test.ts`
- Modify: `apps/server/src/orchestration/runtimeLayer.ts:24-27`

**Interfaces:**
- Produces (consumed by Tasks 3, 4, 5, 6):
  - `type BackgroundWorkKind = "shell" | "subagent" | "workflow" | "monitor" | "spawn"`
  - `interface BackgroundWorkEntry { readonly key: string; readonly kind: BackgroundWorkKind; readonly startedAt: IsoDateTime }`
  - `interface BackgroundWorkSnapshot { readonly count: number; readonly oldestStartedAt: IsoDateTime }`
  - `BackgroundWorkLedgerShape`: `register(threadId, entry): Effect<void>`, `unregister(threadId, key): Effect<void>`, `clearThread(threadId): Effect<void>`, `snapshotFor(threadId): Effect<BackgroundWorkSnapshot | null>`, `sweepBackstop: Effect<ReadonlyArray<ThreadId>>`, `changes: Stream<ThreadId>`, `subscribeChanges: Effect<Queue.Dequeue<ThreadId>, never, Scope.Scope>`.
  - class tag `BackgroundWorkLedger`; layers `makeBackgroundWorkLedgerLive(options?)` and `BackgroundWorkLedgerLive`.

- [ ] **Step 1: Write the service tag file**

Create `apps/server/src/orchestration/Services/BackgroundWorkLedger.ts`:

```ts
import type * as Effect from "effect/Effect";
import type * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as Context from "effect/Context";
import type { IsoDateTime, ThreadId } from "@t3tools/contracts";

/**
 * The kinds of non-blocking work a turn can leave running behind it. `shell`,
 * `subagent`, `workflow`, and `monitor` are native SDK background tasks (mapped
 * from the SDK `task_type`); `spawn` is a cross-provider `spawn_agent` child
 * session (not an SDK task).
 */
export type BackgroundWorkKind = "shell" | "subagent" | "workflow" | "monitor" | "spawn";

export interface BackgroundWorkEntry {
  /** Unique within a thread: the native `task_id`, or the spawn child threadId. */
  readonly key: string;
  readonly kind: BackgroundWorkKind;
  /** ISO timestamp when the work started (the task/job start event time). */
  readonly startedAt: IsoDateTime;
}

export interface BackgroundWorkSnapshot {
  /** Number of live entries for the thread (>= 1 when the snapshot is non-null). */
  readonly count: number;
  /** The minimum `startedAt` across live entries — how long the wait has run. */
  readonly oldestStartedAt: IsoDateTime;
}

export interface BackgroundWorkLedgerShape {
  /** Idempotent on `(threadId, entry.key)`; a repeat is a no-op (keeps the first startedAt). */
  readonly register: (threadId: ThreadId, entry: BackgroundWorkEntry) => Effect.Effect<void>;
  /** No-op if the key is absent. */
  readonly unregister: (threadId: ThreadId, key: string) => Effect.Effect<void>;
  /** Drop every entry for a thread (session stop/teardown). */
  readonly clearThread: (threadId: ThreadId) => Effect.Effect<void>;
  /** Count + oldest startedAt for a thread; `null` when the thread has no live entries. */
  readonly snapshotFor: (threadId: ThreadId) => Effect.Effect<BackgroundWorkSnapshot | null>;
  /**
   * Backstop: drop entries older than the configured window (default 2h) — bounds
   * only the abnormal case where a terminal event never arrived. Returns the
   * threadIds whose sets changed. Driven on a schedule by the layer; also callable
   * directly (used by tests). Publishes a `changes` signal per affected thread.
   */
  readonly sweepBackstop: Effect.Effect<ReadonlyArray<ThreadId>>;
  /** Stream of threadIds whose entry set changed (register/unregister/clear/backstop). */
  readonly changes: Stream.Stream<ThreadId>;
  /** Synchronously-acquired subscription (won't miss a publish); for tests/robust consumers. */
  readonly subscribeChanges: Effect.Effect<Queue.Dequeue<ThreadId>, never, Scope.Scope>;
}

export class BackgroundWorkLedger extends Context.Service<
  BackgroundWorkLedger,
  BackgroundWorkLedgerShape
>()("t3/orchestration/Services/BackgroundWorkLedger") {}
```

- [ ] **Step 2: Write the failing ledger unit test**

Create `apps/server/src/orchestration/Layers/BackgroundWorkLedger.test.ts`:

```ts
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BackgroundWorkLedger } from "../Services/BackgroundWorkLedger.ts";
import { makeBackgroundWorkLedgerLive } from "./BackgroundWorkLedger.ts";

const threadId = ThreadId.make("thread-ledger");
const iso = (s: string) => IsoDateTime.make(s);

describe("BackgroundWorkLedger", () => {
  let runtime: ManagedRuntime.ManagedRuntime<BackgroundWorkLedger, never> | null = null;

  afterEach(async () => {
    if (runtime) await runtime.dispose();
    runtime = null;
  });

  const start = (options?: { backstopMs?: number; sweepIntervalMs?: number }) => {
    runtime = ManagedRuntime.make(makeBackgroundWorkLedgerLive(options));
    return runtime;
  };

  it("counts entries and reports the oldest startedAt", async () => {
    const rt = start();
    const snap = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:02.000Z") });
        yield* ledger.register(threadId, { key: "t2", kind: "workflow", startedAt: iso("2026-01-01T00:00:01.000Z") });
        return yield* ledger.snapshotFor(threadId);
      }),
    );
    expect(snap).toEqual({ count: 2, oldestStartedAt: "2026-01-01T00:00:01.000Z" });
  });

  it("is idempotent on (threadId, key)", async () => {
    const rt = start();
    const snap = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:05.000Z") });
        yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:09.000Z") });
        return yield* ledger.snapshotFor(threadId);
      }),
    );
    expect(snap).toEqual({ count: 1, oldestStartedAt: "2026-01-01T00:00:05.000Z" });
  });

  it("returns null once the last entry is unregistered", async () => {
    const rt = start();
    const snap = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        yield* ledger.register(threadId, { key: "t1", kind: "subagent", startedAt: iso("2026-01-01T00:00:00.000Z") });
        yield* ledger.unregister(threadId, "t1");
        return yield* ledger.snapshotFor(threadId);
      }),
    );
    expect(snap).toBeNull();
  });

  it("clearThread drops every entry for the thread", async () => {
    const rt = start();
    const snap = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:00.000Z") });
        yield* ledger.register(threadId, { key: "t2", kind: "monitor", startedAt: iso("2026-01-01T00:00:00.000Z") });
        yield* ledger.clearThread(threadId);
        return yield* ledger.snapshotFor(threadId);
      }),
    );
    expect(snap).toBeNull();
  });

  it("publishes a change signal on register and unregister", async () => {
    const rt = start();
    const signals = await rt.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* BackgroundWorkLedger;
          const sub = yield* ledger.subscribeChanges;
          yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:00.000Z") });
          const first = yield* Queue.take(sub);
          yield* ledger.unregister(threadId, "t1");
          const second = yield* Queue.take(sub);
          return [first, second];
        }),
      ),
    );
    expect(signals).toEqual([threadId, threadId]);
  });

  it("sweepBackstop expires entries older than the backstop and drops them", async () => {
    const rt = start({ backstopMs: 60 * 60 * 1000 }); // 1h
    const result = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        // startedAt far in the past → well beyond the 1h backstop from "now".
        yield* ledger.register(threadId, { key: "stale", kind: "shell", startedAt: iso("2020-01-01T00:00:00.000Z") });
        const expired = yield* ledger.sweepBackstop;
        const snap = yield* ledger.snapshotFor(threadId);
        return { expired, snap };
      }),
    );
    expect(result.expired).toEqual([threadId]);
    expect(result.snap).toBeNull();
  });

  it("sweepBackstop leaves fresh entries in place", async () => {
    const rt = start({ backstopMs: 60 * 60 * 1000 }); // 1h
    const result = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        const nowMs = yield* Clock.currentTimeMillis;
        const freshStartedAt = iso(new Date(nowMs).toISOString());
        yield* ledger.register(threadId, { key: "fresh", kind: "shell", startedAt: freshStartedAt });
        const expired = yield* ledger.sweepBackstop;
        const snap = yield* ledger.snapshotFor(threadId);
        return { expired, snap, freshStartedAt };
      }),
    );
    expect(result.expired).toEqual([]);
    expect(result.snap).toEqual({ count: 1, oldestStartedAt: result.freshStartedAt });
  });
});
```

`Clock.currentTimeMillis` needs `import * as Clock from "effect/Clock";` at the top of the test file.

- [ ] **Step 3: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/orchestration/Layers/BackgroundWorkLedger.test.ts
```
Expected: FAIL — `./BackgroundWorkLedger.ts` layer module does not exist yet.

- [ ] **Step 4: Write the layer implementation**

Create `apps/server/src/orchestration/Layers/BackgroundWorkLedger.ts`:

```ts
import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import {
  BackgroundWorkLedger,
  type BackgroundWorkEntry,
  type BackgroundWorkLedgerShape,
} from "../Services/BackgroundWorkLedger.ts";

/**
 * Generous reaper backstop (NOT a per-source TTL). Every source has a reliable
 * terminal, so entries are normally cleared by their completion event. This only
 * bounds the abnormal case (an interrupted turn whose task never emits its
 * terminal notification) so a stuck entry cannot pin a session live forever.
 * Deliberately far longer than any per-task timeout: a legitimate multi-hour
 * build or all-day monitor must not be dropped prematurely — the in-view wait
 * timer is the user's cue to interrupt.
 */
const DEFAULT_BACKSTOP_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface BackgroundWorkLedgerLiveOptions {
  readonly backstopMs?: number;
  readonly sweepIntervalMs?: number;
}

type ThreadEntries = ReadonlyMap<string, BackgroundWorkEntry>;
type LedgerState = ReadonlyMap<ThreadId, ThreadEntries>;

const makeBackgroundWorkLedger = (options?: BackgroundWorkLedgerLiveOptions) =>
  Effect.gen(function* () {
    const backstopMs = Math.max(1, options?.backstopMs ?? DEFAULT_BACKSTOP_MS);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const state = yield* Ref.make<LedgerState>(new Map());
    const changes = yield* PubSub.unbounded<ThreadId>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    const register: BackgroundWorkLedgerShape["register"] = (threadId, entry) =>
      Effect.gen(function* () {
        const changed = yield* Ref.modify(state, (map): [boolean, LedgerState] => {
          const existing = map.get(threadId);
          if (existing?.has(entry.key)) return [false, map];
          const next = new Map(map);
          const inner = new Map(existing ?? []);
          inner.set(entry.key, entry);
          next.set(threadId, inner);
          return [true, next];
        });
        if (changed) yield* PubSub.publish(changes, threadId);
      });

    const unregister: BackgroundWorkLedgerShape["unregister"] = (threadId, key) =>
      Effect.gen(function* () {
        const changed = yield* Ref.modify(state, (map): [boolean, LedgerState] => {
          const existing = map.get(threadId);
          if (!existing?.has(key)) return [false, map];
          const next = new Map(map);
          const inner = new Map(existing);
          inner.delete(key);
          if (inner.size === 0) next.delete(threadId);
          else next.set(threadId, inner);
          return [true, next];
        });
        if (changed) yield* PubSub.publish(changes, threadId);
      });

    const clearThread: BackgroundWorkLedgerShape["clearThread"] = (threadId) =>
      Effect.gen(function* () {
        const changed = yield* Ref.modify(state, (map): [boolean, LedgerState] => {
          if (!map.has(threadId)) return [false, map];
          const next = new Map(map);
          next.delete(threadId);
          return [true, next];
        });
        if (changed) yield* PubSub.publish(changes, threadId);
      });

    const snapshotFor: BackgroundWorkLedgerShape["snapshotFor"] = (threadId) =>
      Ref.get(state).pipe(
        Effect.map((map) => {
          const inner = map.get(threadId);
          if (!inner || inner.size === 0) return null;
          let oldest = null as null | BackgroundWorkEntry["startedAt"];
          for (const entry of inner.values()) {
            if (oldest === null || entry.startedAt < oldest) oldest = entry.startedAt;
          }
          // `oldest` is non-null because inner.size >= 1.
          return { count: inner.size, oldestStartedAt: oldest! };
        }),
      );

    const sweepBackstop: BackgroundWorkLedgerShape["sweepBackstop"] = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const affected = yield* Ref.modify(state, (map): [ReadonlyArray<ThreadId>, LedgerState] => {
        const changedThreads: ThreadId[] = [];
        let next: Map<ThreadId, ThreadEntries> | null = null;
        for (const [threadId, inner] of map) {
          let innerNext: Map<string, BackgroundWorkEntry> | null = null;
          for (const [key, entry] of inner) {
            if (nowMs - Date.parse(entry.startedAt) >= backstopMs) {
              innerNext ??= new Map(inner);
              innerNext.delete(key);
            }
          }
          if (innerNext) {
            next ??= new Map(map);
            changedThreads.push(threadId);
            if (innerNext.size === 0) next.delete(threadId);
            else next.set(threadId, innerNext);
          }
        }
        return [changedThreads, next ?? map];
      });
      yield* Effect.forEach(affected, (threadId) => PubSub.publish(changes, threadId), {
        discard: true,
      });
      return affected;
    });

    // Backstop sweep fiber, tied to this layer's scope. `sweepBackstop` cannot
    // fail (error channel `never`); guard only against defects.
    yield* Effect.forkScoped(
      sweepBackstop.pipe(
        Effect.catchDefect((defect: unknown) =>
          Effect.logWarning("background-work.ledger.sweep-defect", { defect }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
      ),
    );

    return {
      register,
      unregister,
      clearThread,
      snapshotFor,
      sweepBackstop,
      get changes() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    } satisfies BackgroundWorkLedgerShape;
  });

export const makeBackgroundWorkLedgerLive = (options?: BackgroundWorkLedgerLiveOptions) =>
  Layer.effect(BackgroundWorkLedger, makeBackgroundWorkLedger(options));

export const BackgroundWorkLedgerLive = makeBackgroundWorkLedgerLive();
```

- [ ] **Step 5: Run the ledger tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/orchestration/Layers/BackgroundWorkLedger.test.ts
```
Expected: PASS (all cases). If `Effect.catchDefect` or `PubSub.subscribe` shape differs in this `effect-smol` build, mirror `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts` (which uses `PubSub.subscribe` and `PubSub.unbounded`) and `ProviderSessionReaper.ts` (which uses `Effect.catchDefect`).

- [ ] **Step 6: Wire the layer into `OrchestrationLayerLive` (single shared provide point)**

In `apps/server/src/orchestration/runtimeLayer.ts`, add the import and include the layer in the `mergeAll` (`:24-27`):

```ts
import { BackgroundWorkLedgerLive } from "./Layers/BackgroundWorkLedger.ts";

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
  BackgroundWorkLedgerLive,
);
```

The ledger has no dependencies (Clock is an ambient runtime service), so `mergeAll` needs nothing provided to it. This exposes `BackgroundWorkLedger` in `OrchestrationLayerLive`'s output, which is `Layer.provideMerge`d into `ProviderRuntimeLayerLive` (reaper) and the full runtime graph (ingestion, spawn) — one memoized instance shared by all consumers.

- [ ] **Step 7: Typecheck the server**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 typecheck
```
Expected: clean (the layer is wired but not yet consumed — no unmet requirements).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/orchestration/Services/BackgroundWorkLedger.ts \
        apps/server/src/orchestration/Layers/BackgroundWorkLedger.ts \
        apps/server/src/orchestration/Layers/BackgroundWorkLedger.test.ts \
        apps/server/src/orchestration/runtimeLayer.ts
git commit -m "feat(server): add BackgroundWorkLedger service, layer, and backstop sweep"
```

---

## Task 3: Native-task feeder + `clearThread` (ProviderRuntimeIngestion)

**Files:**
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (service access `:746-756`; a new task-event block near the lifecycle handling `:1470-1553`; the `session.exited` teardown `:1778-1780`; layer provide `:1919-1922`)
- Test: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`

**Interfaces:**
- Consumes: `BackgroundWorkLedger` (Task 2) — `register`, `unregister`, `clearThread`.
- Produces: after a `task.started` runtime event, the ledger has an entry `{key: taskId, kind, startedAt}`; after `task.completed`, it is gone; after `session.exited`, the thread is cleared.

- [ ] **Step 1: Expose the ledger from the test harness**

`ProviderRuntimeIngestion.test.ts` builds its runtime in `createHarness()` (`:239-324`). It composes a `layer` (`:241-249`), makes a `ManagedRuntime`, and returns `{ engine, readModel, emit, setProviderSession, drain }`. `emit(event)` publishes a `ProviderRuntimeEvent` to the stub provider's PubSub; `readModel()` returns the projected snapshot (`.threads[]`, each with `.session`).

Make three edits to `createHarness`:

1. Add imports at the top of the file:
   ```ts
   import { BackgroundWorkLedger } from "../Services/BackgroundWorkLedger.ts";
   import { makeBackgroundWorkLedgerLive } from "./BackgroundWorkLedger.ts";
   ```
   and add `RuntimeTaskId` to the `@t3tools/contracts` import.
2. Add `Layer.provideMerge(makeBackgroundWorkLedgerLive())` to the `layer` pipe (`:241-249`) so the ledger is the shared instance the ingestion layer feeds.
3. After `const ingestion = await runtime.runPromise(...)` (`:253`), acquire the ledger, and add it to the return object (`:317-323`):
   ```ts
   const ledger = await runtime.runPromise(Effect.service(BackgroundWorkLedger));
   // ...
   return {
     engine,
     readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
     emit: provider.emit,
     setProviderSession: provider.setSession,
     drain,
     ledger,
   };
   ```
   The ledger's methods are self-contained Effects (no context requirement), so tests can run them directly with `Effect.runPromise(harness.ledger.snapshotFor(...))`.

- [ ] **Step 2: Write the failing test**

Add (the seed thread is `"thread-1"`, created inside `createHarness`):

```ts
it("registers a native background task on task.started and clears it on task.completed", async () => {
  const harness = await createHarness();
  const threadId = ThreadId.make("thread-1");

  harness.emit({
    type: "task.started",
    eventId: asEventId("evt-task-started-bg"),
    provider: ProviderDriverKind.make("codex"),
    createdAt: "2026-01-01T00:00:00.000Z",
    threadId: asThreadId("thread-1"),
    payload: { taskId: RuntimeTaskId.make("task-1"), taskType: "shell" },
  });
  await harness.drain();
  expect(await Effect.runPromise(harness.ledger.snapshotFor(threadId))).toMatchObject({ count: 1 });

  harness.emit({
    type: "task.completed",
    eventId: asEventId("evt-task-completed-bg"),
    provider: ProviderDriverKind.make("codex"),
    createdAt: "2026-01-01T00:00:01.000Z",
    threadId: asThreadId("thread-1"),
    payload: { taskId: RuntimeTaskId.make("task-1"), status: "completed" },
  });
  await harness.drain();
  expect(await Effect.runPromise(harness.ledger.snapshotFor(threadId))).toBeNull();
});
```

> `asEventId`/`asThreadId` are existing helpers in this file. Task events carry a **nested `payload`** (unlike the flattened legacy turn events); the harness's `normalizeLegacyEvent` passes non-turn events through unchanged. If `emit`'s `LegacyProviderRuntimeEvent` param type rejects the nested task payload, append `as never` to the event literal.

- [ ] **Step 3: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t "registers a native background task"
```
Expected: FAIL — the ledger stays empty (`snapshotFor` is `null` after `task.started`), because nothing feeds it yet.

- [ ] **Step 4: Inject the ledger + add the `taskType → kind` mapper**

In `ProviderRuntimeIngestion.ts`, at the top of the `make` generator (`:746-756`), add:

```ts
const ledger = yield* BackgroundWorkLedger;
```

Add the import near the other service imports:

```ts
import { BackgroundWorkLedger } from "../Services/BackgroundWorkLedger.ts";
import type { BackgroundWorkKind } from "../Services/BackgroundWorkLedger.ts";
```

Add a module-scope mapper (near the other top-level helpers in the file):

```ts
/**
 * Map the SDK `task_type` carried on `task.started` to a ledger kind. Unknown or
 * absent types (e.g. an in-turn "plan" task) fall back to "subagent" — harmless
 * for the count, which is all that gates the pill and the reaper. NOTE: confirm
 * the exact runtime `task_type` strings against the daemon if kinds ever surface
 * in the UI (open question in the design).
 */
const taskTypeToBackgroundKind = (taskType: string | undefined): BackgroundWorkKind => {
  switch (taskType) {
    case "shell":
      return "shell";
    case "subagent":
      return "subagent";
    case "workflow":
    case "local_workflow":
      return "workflow";
    case "monitor":
      return "monitor";
    default:
      return "subagent";
  }
};
```

- [ ] **Step 5: Feed the ledger on task events**

In `processRuntimeEvent`, after the session-lifecycle `if (...) { ... }` block closes (`:1553`) — where the resolved thread shell is in scope as `thread` and `event.createdAt` as the timestamp — add a sibling block:

```ts
if (event.type === "task.started") {
  yield* ledger.register(thread.id, {
    key: event.payload.taskId,
    kind: taskTypeToBackgroundKind(event.payload.taskType),
    startedAt: event.createdAt,
  });
} else if (event.type === "task.completed") {
  yield* ledger.unregister(thread.id, event.payload.taskId);
}
```

`event.payload.taskId` is a `RuntimeTaskId` (a string brand — assignable to the ledger's `string` key). Foreground (blocking) tasks register and unregister *within* their turn (status is `running`, so the pill/reaper ignore them); only genuinely backgrounded tasks survive past `turn.completed`.

- [ ] **Step 6: Clear the thread on `session.exited`**

In the existing teardown branch (`:1778-1780`):

```ts
if (event.type === "session.exited") {
  yield* clearTurnStateForSession(thread.id);
  yield* ledger.clearThread(thread.id);
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t "registers a native background task"
pnpm --filter t3 typecheck
```
Expected: PASS and clean typecheck. (Typecheck now also confirms the ingestion layer's new `BackgroundWorkLedger` requirement is satisfied by the runtime graph.)

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts \
        apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
git commit -m "feat(server): feed BackgroundWorkLedger from native task lifecycle events"
```

---

## Task 4: Project `backgroundWork` onto the session + between-turns push

**Files:**
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (lifecycle dispatch `:1534-1551`; runtime-error dispatch `:1790-1807`; `start()` fibers `:1896-1911`; add a `nowIso` helper)
- Test: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`

**Interfaces:**
- Consumes: `BackgroundWorkLedger.snapshotFor`, `.changes`; `OrchestrationSession.backgroundWork` (Task 1).
- Produces: every `thread.session.set` dispatch carries `session.backgroundWork = snapshotFor(threadId)`; a between-turns ledger change re-emits `thread.session.set` (same status) with the fresh `backgroundWork`.

- [ ] **Step 1: Write the failing tests**

Add to `ProviderRuntimeIngestion.test.ts`. These reuse the same `createHarness` (with the ledger exposed in Task 3), `harness.emit`, `harness.readModel`, and the existing `waitForThread(readModelFn, predicate)` helper (used elsewhere in this file, e.g. `:470`, `:574`):

```ts
it("projects backgroundWork onto the session when a turn completes with pending work", async () => {
  const harness = await createHarness();
  harness.emit({ type: "turn.started", eventId: asEventId("evt-ts-bg"), provider: ProviderDriverKind.make("codex"), createdAt: "2026-01-01T00:00:00.000Z", threadId: asThreadId("thread-1"), turnId: asTurnId("turn-bg") });
  harness.emit({ type: "task.started", eventId: asEventId("evt-task-bg"), provider: ProviderDriverKind.make("codex"), createdAt: "2026-01-01T00:00:00.500Z", threadId: asThreadId("thread-1"), payload: { taskId: RuntimeTaskId.make("task-bg"), taskType: "workflow" } });
  harness.emit({ type: "turn.completed", eventId: asEventId("evt-tc-bg"), provider: ProviderDriverKind.make("codex"), createdAt: "2026-01-01T00:00:01.000Z", threadId: asThreadId("thread-1"), turnId: asTurnId("turn-bg"), status: "completed" });
  await harness.drain();

  const rm = await harness.readModel();
  const thread = rm.threads.find((t) => t.id === ThreadId.make("thread-1"));
  expect(thread?.session?.status).toBe("ready");
  expect(thread?.session?.backgroundWork).toMatchObject({ count: 1 });
});

it("clears backgroundWork between turns when the last task completes", async () => {
  const harness = await createHarness();
  harness.emit({ type: "turn.started", eventId: asEventId("evt-ts-bg2"), provider: ProviderDriverKind.make("codex"), createdAt: "2026-01-01T00:00:00.000Z", threadId: asThreadId("thread-1"), turnId: asTurnId("turn-bg2") });
  harness.emit({ type: "task.started", eventId: asEventId("evt-task-bg2"), provider: ProviderDriverKind.make("codex"), createdAt: "2026-01-01T00:00:00.500Z", threadId: asThreadId("thread-1"), payload: { taskId: RuntimeTaskId.make("task-bg2"), taskType: "shell" } });
  harness.emit({ type: "turn.completed", eventId: asEventId("evt-tc-bg2"), provider: ProviderDriverKind.make("codex"), createdAt: "2026-01-01T00:00:01.000Z", threadId: asThreadId("thread-1"), turnId: asTurnId("turn-bg2"), status: "completed" });
  await harness.drain();
  expect((await harness.readModel()).threads.find((t) => t.id === ThreadId.make("thread-1"))?.session?.backgroundWork).toMatchObject({ count: 1 });

  // Task finishes AFTER the turn already settled → only the forked changes fiber updates the UI
  // (it dispatches directly to the engine, not through the ingestion worker queue, so poll).
  harness.emit({ type: "task.completed", eventId: asEventId("evt-taskdone-bg2"), provider: ProviderDriverKind.make("codex"), createdAt: "2026-01-01T00:00:02.000Z", threadId: asThreadId("thread-1"), payload: { taskId: RuntimeTaskId.make("task-bg2"), status: "completed" } });
  await harness.drain();

  await waitForThread(harness.readModel, (thread) => (thread.session?.backgroundWork ?? null) === null);
});
```

> `asTurnId`/`asEventId`/`asThreadId` are existing helpers in this file. `waitForThread` polls `readModel()` until the predicate holds — necessary here because the between-turns fiber dispatches to the engine outside the ingestion worker queue, so `drain()` alone won't await it.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t "backgroundWork"
```
Expected: FAIL — `session.backgroundWork` is `undefined` (projection not wired) and does not update between turns.

- [ ] **Step 3: Add a `nowIso` helper**

Near the top of `make` (`:746-756`), add:

```ts
const nowIso = DateTime.now.pipe(Effect.map((dt) => IsoDateTime.make(DateTime.formatIso(dt))));
```

Ensure `import * as DateTime from "effect/DateTime";` and `IsoDateTime` (from `@t3tools/contracts`) are imported (add if absent — the file already builds `updatedAt` from `IsoDateTime`-typed values).

- [ ] **Step 4: Inject `backgroundWork` into the lifecycle dispatch**

In the lifecycle block, immediately **before** the `orchestrationEngine.dispatch({ type: "thread.session.set", ... })` call (`:1534`), read the snapshot:

```ts
const backgroundWork = yield* ledger.snapshotFor(thread.id);
```

and add `backgroundWork,` to the `session` object literal (`:1537-1548`), e.g. right after `lastError,`:

```ts
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              backgroundWork,
              updatedAt: now,
            },
```

- [ ] **Step 5: Inject `backgroundWork` into the runtime-error dispatch**

Do the same at the `runtime.error` dispatch (`:1790-1807`): add `const backgroundWork = yield* ledger.snapshotFor(thread.id);` before that dispatch and `backgroundWork,` into its `session` literal.

- [ ] **Step 6: Add the between-turns push fiber**

In `start()` (`:1896-1911`), after the two existing `Effect.forkScoped(...)` fibers, add a third that reacts to ledger changes and re-emits `thread.session.set` with the current status but a refreshed `backgroundWork`:

```ts
yield* Effect.forkScoped(
  Stream.runForEach(ledger.changes, (threadId) =>
    Effect.gen(function* () {
      const shellOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(shellOption)) return;
      const session = shellOption.value.session;
      // During an active turn the "Working" status already outranks "Background"
      // in the UI, and the eventual turn.completed dispatch re-reads the snapshot.
      if (!session || session.status === "running") return;

      const backgroundWork = yield* ledger.snapshotFor(threadId);
      const now = yield* nowIso;
      const commandId = CommandId.make(`background-work:${threadId}:${yield* crypto.randomUUIDv4}`);
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId,
        threadId,
        session: {
          threadId: session.threadId,
          status: session.status,
          providerName: session.providerName,
          ...(session.providerInstanceId !== undefined
            ? { providerInstanceId: session.providerInstanceId }
            : {}),
          runtimeMode: session.runtimeMode,
          activeTurnId: session.activeTurnId,
          lastError: session.lastError,
          backgroundWork,
          updatedAt: now,
        },
        createdAt: now,
      });
    }).pipe(
      Effect.catchDefect((defect: unknown) =>
        Effect.logWarning("background-work.ingestion.changes-defect", { defect }),
      ),
    ),
  ),
);
```

Ensure `Option` is imported (`import * as Option from "effect/Option";`) — add if absent. `CommandId`, `crypto`, `projectionSnapshotQuery`, and `orchestrationEngine` are already in scope (`:746-756`). This fiber reacts only to `ledger.changes` (never to `thread.session.set`), so it cannot loop.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t "backgroundWork"
pnpm --filter t3 typecheck
```
Expected: PASS and clean typecheck.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts \
        apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
git commit -m "feat(server): project backgroundWork onto sessions and push updates between turns"
```

---

## Task 5: `spawn_agent` feeder

**Files:**
- Modify: `apps/server/src/mcp/toolkits/spawn/handlers.ts` (deps `:46-52`, `:80-87`; `putJob`/`patchJob` `:89-103`)
- Modify: `apps/server/src/mcp/McpHttpServer.ts:242-255` (inject the ledger)
- Test: `apps/server/src/mcp/toolkits/spawn/handlers.test.ts`

**Interfaces:**
- Consumes: `BackgroundWorkLedger` (Task 2) — `register`, `unregister`.
- Produces: a spawn job created `running` registers `{key: childThreadId, kind: "spawn", startedAt}`; a job reaching a terminal status (`completed`/`failed`/`timedOut`) unregisters it.

- [ ] **Step 1: Give `makeDeps` a ledger (default no-op) and write the failing test**

`handlers.test.ts` builds deps via `makeDeps(options)` (`:52`), which returns `Parameters<typeof makeSpawnAgentHandlers>[0]`. Tests run as `it.effect`/`it.live` (effect-aware, from `vite-plus/test`) and create jobs with `spawnAgent({ providerInstanceId, prompt }, invocation(0))`. The job's parent thread is `PARENT_THREAD_ID`.

First, add imports and a no-op ledger so all existing `makeDeps` callers keep compiling once `SpawnAgentDeps` gains the required field (Step 3):

```ts
import { BackgroundWorkLedger } from "../../../orchestration/Services/BackgroundWorkLedger.ts";
import { makeBackgroundWorkLedgerLive } from "../../../orchestration/Layers/BackgroundWorkLedger.ts";
import * as Stream from "effect/Stream";

const noopLedger = {
  register: () => Effect.void,
  unregister: () => Effect.void,
  clearThread: () => Effect.void,
  snapshotFor: () => Effect.succeed(null),
  sweepBackstop: Effect.succeed([]),
  changes: Stream.empty,
  subscribeChanges: Effect.die("unused"),
} as unknown as typeof BackgroundWorkLedger.Service;
```

Add `backgroundWorkLedger?` to the `makeDeps` options type and thread it into the returned deps object:

```ts
const makeDeps = (options: {
  // ...existing fields...
  readonly backgroundWorkLedger?: typeof BackgroundWorkLedger.Service;
}): Parameters<typeof makeSpawnAgentHandlers>[0] => {
  // ...existing body...
  return {
    providerService, // ...existing...
    crypto: makeCrypto(),
    backgroundWorkLedger: options.backgroundWorkLedger ?? noopLedger,
  };
};
```

Then add the test, providing a real ledger for this case only:

```ts
it.effect("registers a spawned agent in the background-work ledger while it runs", () =>
  Effect.gen(function* () {
    const backgroundWorkLedger = yield* BackgroundWorkLedger;
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({ instance: codexInstance, dispatchSink, backgroundWorkLedger });
    const { spawnAgent } = makeSpawnAgentHandlers(deps);

    yield* spawnAgent({ providerInstanceId: "codex", prompt: "x" }, invocation(0));

    const snap = yield* backgroundWorkLedger.snapshotFor(PARENT_THREAD_ID);
    expect(snap).toMatchObject({ count: 1 });
  }).pipe(Effect.provide(makeBackgroundWorkLedgerLive())),
);
```

> `PARENT_THREAD_ID`, `codexInstance`, `invocation`, and `OrchestrationCommand` are already defined/imported in this file. If `PARENT_THREAD_ID` is a raw string, wrap it as `ThreadId.make(PARENT_THREAD_ID)` in the `snapshotFor` call.

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/mcp/toolkits/spawn/handlers.test.ts -t "background-work ledger"
```
Expected: FAIL — `SpawnAgentDeps` has no `backgroundWorkLedger` (compile error), or the ledger is empty.

- [ ] **Step 3: Add the ledger to `SpawnAgentDeps`**

In `handlers.ts`, extend the deps interface (`:46-52`):

```ts
import type { BackgroundWorkLedger } from "../../../orchestration/Services/BackgroundWorkLedger.ts";

export interface SpawnAgentDeps {
  readonly providerService: typeof ProviderService.Service;
  readonly instanceRegistry: typeof ProviderInstanceRegistry.Service;
  readonly orchestrationEngine: typeof OrchestrationEngineService.Service;
  readonly snapshotQuery: typeof ProjectionSnapshotQuery.Service;
  readonly crypto: typeof Crypto.Crypto.Service;
  readonly backgroundWorkLedger: typeof BackgroundWorkLedger.Service;
}
```

and destructure it (`:81`):

```ts
const { providerService, instanceRegistry, orchestrationEngine, snapshotQuery, crypto, backgroundWorkLedger } = deps;
```

- [ ] **Step 4: Register/unregister in `putJob`/`patchJob`**

Replace `putJob` and `patchJob` (`:90-101`) so they feed the ledger (keeping their `Effect`-returning signatures):

```ts
const putJob = (job: SpawnJob): Effect.Effect<void> =>
  Effect.gen(function* () {
    jobs.set(job.childThreadId, job);
    if (job.status === "running") {
      yield* backgroundWorkLedger.register(job.parentThreadId, {
        key: job.childThreadId,
        kind: "spawn",
        startedAt: job.startedAt,
      });
    }
  });
const patchJob = (childThreadId: ThreadId, patch: Partial<SpawnJob>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const existing = jobs.get(childThreadId);
    if (!existing) return;
    const updated = { ...existing, ...patch };
    jobs.set(childThreadId, updated);
    // A job leaving "running" (completed/failed/timedOut) is terminal → release it.
    if (existing.status === "running" && updated.status !== "running") {
      yield* backgroundWorkLedger.unregister(updated.parentThreadId, childThreadId);
    }
  });
```

`job.parentThreadId` / `job.childThreadId` are `ThreadId`s (`:58-59`); `job.startedAt` is `IsoDateTime` (`:66`). A `spawn` child is a cross-provider session with no SDK `task_id`, so its `childThreadId` key cannot collide with a native-task key on the same thread.

- [ ] **Step 5: Inject the ledger at the call site**

In `apps/server/src/mcp/McpHttpServer.ts`, `registerSpawnToolkit` (`:242-255`), acquire the ledger and pass it in:

```ts
const registerSpawnToolkit = Effect.fn("McpHttpServer.registerSpawnToolkit")(function* () {
  const server = yield* McpServer.McpServer;
  const providerService = yield* ProviderService;
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const backgroundWorkLedger = yield* BackgroundWorkLedger;
  const handlers = makeSpawnAgentHandlers({
    providerService,
    instanceRegistry,
    orchestrationEngine,
    snapshotQuery,
    crypto,
    backgroundWorkLedger,
  });
  // ...unchanged...
```

Add `import { BackgroundWorkLedger } from "../orchestration/Services/BackgroundWorkLedger.ts";` at the top. (The McpHttpServer runs in the full runtime, which provides `BackgroundWorkLedger` via `OrchestrationLayerLive` — typecheck confirms.)

- [ ] **Step 6: Run tests + typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/mcp/toolkits/spawn/handlers.test.ts
pnpm --filter t3 typecheck
```
Expected: PASS and clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mcp/toolkits/spawn/handlers.ts \
        apps/server/src/mcp/toolkits/spawn/handlers.test.ts \
        apps/server/src/mcp/McpHttpServer.ts
git commit -m "feat(server): register spawn_agent jobs in the BackgroundWorkLedger"
```

---

## Task 6: Reaper reads the ledger; remove `hasPendingBackgroundWork`

**Files:**
- Modify: `apps/server/src/provider/Layers/ProviderSessionReaper.ts` (deps `:24-28`; the guard `:105-120`)
- Modify: `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts` (harness + cases)
- Modify: `apps/server/src/provider/Services/ProviderService.ts:104-113` (remove interface member)
- Modify: `apps/server/src/provider/Layers/ProviderService.ts:1115-1128,1147` (remove impl + return entry)
- Modify: `apps/server/src/provider/Services/ProviderAdapter.ts:104-114` (remove optional member)
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts:4606-4612,4663` (remove impl + return entry)

**Interfaces:**
- Consumes: `BackgroundWorkLedger.snapshotFor` (Task 2).
- Removes: `ProviderService.hasPendingBackgroundWork`, `ProviderAdapterShape.hasPendingBackgroundWork`, `ClaudeAdapterShape` inherited member impl. No shim — the ledger is the single source of truth.

- [ ] **Step 1: Update the reaper test harness (write the failing test)**

In `ProviderSessionReaper.test.ts`:

1. Add imports:
   ```ts
   import { BackgroundWorkLedger } from "../Services/BackgroundWorkLedger.ts";
   import { makeBackgroundWorkLedgerLive } from "../../orchestration/Layers/BackgroundWorkLedger.ts";
   ```
2. In `createHarness`, **remove** `hasPendingBackgroundWork` from the `providerService` stub (`:166-167`) and the `pendingBackgroundWorkThreadIds` parameter (`:145`).
3. Add `Layer.provideMerge(makeBackgroundWorkLedgerLive())` to the reaper `layer` composition (`:195-230`), and widen the `runtime` type param (`:123-126`) to include `BackgroundWorkLedger`.
4. Rewrite the existing "skips stale sessions that are hosting pending background work" test (`:331-381`) to register a ledger entry before starting the reaper:
   ```ts
   it("skips stale sessions that are hosting pending background work (task kind)", async () => {
     const threadId = ThreadId.make("thread-reaper-bg-work");
     const now = "2026-01-01T00:00:00.000Z";
     const harness = await createHarness({
       readModel: makeReadModel([{ id: threadId, session: {
         threadId, status: "ready", providerName: "claudeAgent",
         runtimeMode: "full-access", activeTurnId: null, lastError: null, updatedAt: now,
       }}]),
     });
     // ...repository.upsert(...) as before (lastSeenAt far in the past)...

     await runtime!.runPromise(
       Effect.flatMap(BackgroundWorkLedger, (ledger) =>
         ledger.register(threadId, { key: "task-1", kind: "shell", startedAt: IsoDateTime.make(now) }),
       ),
     );

     const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
     scope = await Effect.runPromise(Scope.make("sequential"));
     await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
     await Effect.runPromise(drainFibers);

     expect(harness.stopSession).not.toHaveBeenCalled();
     const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
     expect(Option.isSome(remaining)).toBe(true);
   });
   ```
   (Import `IsoDateTime` from `@t3tools/contracts`.)
5. Add a **spawn-kind** variant (same as above but `kind: "spawn"`, `key: <a child threadId string>`), and a **becomes-eligible** case: register then `unregister` (or `clearThread`) before `reaper.start()`, and assert the session **is** reaped (`stopSession` called once) — mirroring the existing "reaps stale persisted sessions" test's assertion via `waitFor(() => harness.stopSession.mock.calls.length === 1)`.

- [ ] **Step 2: Run the reaper tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/provider/Layers/ProviderSessionReaper.test.ts
```
Expected: FAIL/compile-error — the stub still references the (to-be-removed) `hasPendingBackgroundWork`, and the reaper still consults it rather than the ledger.

- [ ] **Step 3: Swap the reaper guard to the ledger**

In `ProviderSessionReaper.ts`, add the ledger dependency (`:24-28`):

```ts
const providerService = yield* ProviderService;
const directory = yield* ProviderSessionDirectory;
const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
const backgroundWorkLedger = yield* BackgroundWorkLedger;
```

with `import { BackgroundWorkLedger } from "../../orchestration/Services/BackgroundWorkLedger.ts";`.

Replace the guard (`:105-120`) with:

```ts
// A session with no active turn can still be hosting background work the agent
// launched and is waiting on (a Workflow, backgrounded Bash/subagent, MCP
// monitor, or spawn_agent child). `lastSeenAt` does not advance for that work,
// so without this guard the reaper tears the session down, orphaning the work
// and losing the completion that would re-invoke the agent.
const backgroundWork = yield* backgroundWorkLedger.snapshotFor(binding.threadId);
if (backgroundWork !== null) {
  yield* Effect.logDebug("provider.session.reaper.skipped-pending-background-work", {
    threadId: binding.threadId,
    provider: binding.provider,
    backgroundWorkCount: backgroundWork.count,
    idleDurationMs,
  });
  continue;
}
```

- [ ] **Step 4: Remove `hasPendingBackgroundWork` everywhere**

Delete the method from all four surfaces:

- `apps/server/src/provider/Services/ProviderService.ts` — remove the interface member (`:104-113`, including its doc comment).
- `apps/server/src/provider/Layers/ProviderService.ts` — remove the `const hasPendingBackgroundWork = ...` implementation (`:1115-1128`) and the `hasPendingBackgroundWork,` entry in the returned service object (`:1147`).
- `apps/server/src/provider/Services/ProviderAdapter.ts` — remove the optional interface member (`:104-114`, including its doc comment).
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — remove the `const hasPendingBackgroundWork = ...` implementation (`:4606-4612`) and the `hasPendingBackgroundWork,` entry in the returned adapter object (`:4663`). Leave `workflowWatchers` and the workflow disk-watcher machinery untouched (it still drives the nested-tree UI).

Then confirm nothing else references it:

```bash
grep -rn "hasPendingBackgroundWork" apps/ packages/
```
Expected: **no matches**. Remove any stragglers (other adapters, other tests).

- [ ] **Step 5: Run the reaper tests + typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter t3 test src/provider/Layers/ProviderSessionReaper.test.ts
pnpm --filter t3 typecheck
```
Expected: PASS (including the new spawn-kind + becomes-eligible cases) and clean typecheck (the reaper's new `BackgroundWorkLedger` requirement is satisfied via `ProviderRuntimeLayerLive → OrchestrationLayerLive`).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/
git commit -m "refactor(server): reaper reads BackgroundWorkLedger; drop hasPendingBackgroundWork"
```

---

## Task 7: Web — sidebar "Background" pill

**Files:**
- Modify: `apps/web/src/types.ts:167-176` (`ThreadSession`)
- Modify: `apps/web/src/store.ts:167-178` (`mapSession`)
- Modify: `apps/web/src/components/Sidebar.logic.ts:28-48` (label union + priority), `:379-402` (new branch)
- Test: `apps/web/src/components/Sidebar.logic.test.ts:494-592`

**Interfaces:**
- Consumes: `OrchestrationSession.backgroundWork` (Task 1) via `mapSession`.
- Produces: `ThreadSession.backgroundWork?: { count: number; oldestStartedAt: string } | null`; `resolveThreadStatusPill` returns a `{ label: "Background", pulse: true, ... }` pill ranked below Working/Connecting/Approval/Input and Plan Ready, above Completed.

- [ ] **Step 1: Write the failing pill tests**

In `apps/web/src/components/Sidebar.logic.test.ts`, inside `describe("resolveThreadStatusPill", ...)` (`:494`), add:

```ts
it("shows the Background pill when background work is pending after the turn settled", () => {
  expect(
    resolveThreadStatusPill({
      thread: {
        ...baseThread,
        interactionMode: "default",
        session: {
          ...baseThread.session,
          status: "ready",
          orchestrationStatus: "ready",
          backgroundWork: { count: 2, oldestStartedAt: "2026-03-09T10:00:00.000Z" },
        },
      },
    }),
  ).toMatchObject({ label: "Background", pulse: true });
});

it("prefers Working over Background while a turn is active", () => {
  expect(
    resolveThreadStatusPill({
      thread: {
        ...baseThread,
        session: {
          ...baseThread.session,
          status: "running",
          orchestrationStatus: "running",
          backgroundWork: { count: 1, oldestStartedAt: "2026-03-09T10:00:00.000Z" },
        },
      },
    }),
  ).toMatchObject({ label: "Working", pulse: true });
});

it("prefers Background over Completed when both would apply", () => {
  expect(
    resolveThreadStatusPill({
      thread: {
        ...baseThread,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: {
          ...baseThread.session,
          status: "ready",
          orchestrationStatus: "ready",
          backgroundWork: { count: 1, oldestStartedAt: "2026-03-09T10:00:00.000Z" },
        },
      },
    }),
  ).toMatchObject({ label: "Background", pulse: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter @t3tools/web test src/components/Sidebar.logic.test.ts -t "Background"
```
Expected: FAIL — TS error (`backgroundWork` not on `ThreadSession`) and/or no "Background" label returned.

- [ ] **Step 3: Add `backgroundWork` to `ThreadSession`**

In `apps/web/src/types.ts` (`:167-176`), add the optional field:

```ts
export interface ThreadSession {
  provider: ProviderDriverKind;
  providerInstanceId?: ProviderInstanceId | undefined;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
  backgroundWork?: { count: number; oldestStartedAt: string } | null;
}
```

Optional so existing `ThreadSession` object literals (including test fixtures like `baseThread.session`) keep compiling. This covers both `SidebarThreadSummary.session` and `OrchestrationThread.session` (both reference `ThreadSession`).

- [ ] **Step 4: Map it through `mapSession`**

In `apps/web/src/store.ts` `mapSession` (`:167-178`), add the explicit line (this mapper is field-by-field):

```ts
function mapSession(session: OrchestrationSession): ThreadSession {
  return {
    provider: toLegacyProvider(session.providerName),
    providerInstanceId: session.providerInstanceId ?? undefined,
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
    backgroundWork: session.backgroundWork ?? null,
  };
}
```

- [ ] **Step 5: Add the "Background" label + priority**

In `apps/web/src/components/Sidebar.logic.ts`, extend the `ThreadStatusPill["label"]` union (`:28-35`) with `"Background"`:

```ts
export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready"
    | "Background";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}
```

Update `THREAD_STATUS_PRIORITY` (`:41-48`) so `Background` sits above `Completed` and below `Plan Ready` (renumber to preserve every existing relative order; the table is only used for `>` comparison at `:414`):

```ts
const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 6,
  "Awaiting Input": 5,
  Working: 4,
  Connecting: 4,
  "Plan Ready": 3,
  Background: 2,
  Completed: 1,
};
```

- [ ] **Step 6: Add the branch in `resolveThreadStatusPill`**

In `resolveThreadStatusPill` (`:338-403`), insert a new branch **after** the `hasPlanReadyPrompt` block and **before** the `hasUnseenCompletion` block:

```ts
  if (thread.session?.backgroundWork != null) {
    return {
      label: "Background",
      colorClass: "text-cyan-600 dark:text-cyan-300/80",
      dotClass: "bg-cyan-500 dark:bg-cyan-300/80",
      pulse: true,
    };
  }
```

First-match-wins ordering guarantees Working/Connecting (active turn) and Approval/Input/Plan Ready already returned earlier when applicable, so this fires only for a settled session with pending background work, and outranks "Completed". No change is needed in `ThreadStatusIndicators.tsx` — it renders purely from `colorClass`/`dotClass`/`pulse`.

- [ ] **Step 7: Run tests + typecheck**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter @t3tools/web test src/components/Sidebar.logic.test.ts
pnpm --filter @t3tools/web typecheck
```
Expected: PASS (new + existing pill tests) and clean typecheck.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/store.ts \
        apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts
git commit -m "feat(web): add cyan Background pill for sessions with pending background work"
```

---

## Task 8: Web — in-view background banner + wait timer

**Files:**
- Modify: `apps/web/src/components/chat/MessagesTimeline.logic.ts:37-70` (row union), `:292-300` (derive input), `:416-424` (emit)
- Test: `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`
- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx:151-172` (props), `:178` (destructure), `:268-289` (memo), `:428-435` (dispatch), `:667-716` (new row component)
- Modify: `apps/web/src/components/ChatView.tsx:4870-4892` (pass the prop)

**Interfaces:**
- Consumes: `ThreadSession.backgroundWork` (Task 7).
- Produces: a `{ kind: "background"; id: "background-indicator-row"; createdAt: string | null }` timeline row emitted when `backgroundWork != null && !isWorking`, rendered like the working row but cyan with a `WorkingTimer` from `backgroundWork.oldestStartedAt`.

- [ ] **Step 1: Write the failing derive tests**

In `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`, add:

```ts
describe("deriveMessagesTimelineRows background row", () => {
  const emptyInput = {
    timelineEntries: [],
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  };

  it("emits a background row when backgroundWork is present and not working", () => {
    const rows = deriveMessagesTimelineRows({
      ...emptyInput,
      backgroundWork: { count: 2, oldestStartedAt: "2026-01-01T00:00:00Z" },
    });
    expect(rows).toContainEqual({
      kind: "background",
      id: "background-indicator-row",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("does not emit a background row while working (working takes precedence)", () => {
    const rows = deriveMessagesTimelineRows({
      ...emptyInput,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      backgroundWork: { count: 1, oldestStartedAt: "2026-01-01T00:00:00Z" },
    });
    expect(rows.some((r) => r.kind === "background")).toBe(false);
    expect(rows.some((r) => r.kind === "working")).toBe(true);
  });

  it("emits no background row when backgroundWork is null", () => {
    const rows = deriveMessagesTimelineRows({ ...emptyInput, backgroundWork: null });
    expect(rows.some((r) => r.kind === "background")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter @t3tools/web test src/components/chat/MessagesTimeline.logic.test.ts -t "background row"
```
Expected: FAIL — TS error (`backgroundWork` not on the input) / no background row.

- [ ] **Step 3: Add the row variant + derive input + emit**

In `apps/web/src/components/chat/MessagesTimeline.logic.ts`:

Add to the `MessagesTimelineRow` union (`:37-70`, after the `working` variant):

```ts
  | { kind: "working"; id: string; createdAt: string | null }
  | { kind: "background"; id: string; createdAt: string | null };
```

Add `backgroundWork` to the `deriveMessagesTimelineRows` input (`:292-300`):

```ts
export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  backgroundWork?: { count: number; oldestStartedAt: string } | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
```

Replace the working-row emit (`:416-424`) with a working-else-background emit:

```ts
  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  } else if (input.backgroundWork != null) {
    nextRows.push({
      kind: "background",
      id: "background-indicator-row",
      createdAt: input.backgroundWork.oldestStartedAt,
    });
  }

  return nextRows;
}
```

- [ ] **Step 4: Run the derive tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter @t3tools/web test src/components/chat/MessagesTimeline.logic.test.ts -t "background row"
```
Expected: PASS.

- [ ] **Step 5: Add the `BackgroundTimelineRow` component + dispatch + prop threading**

In `apps/web/src/components/chat/MessagesTimeline.tsx`:

Add `backgroundWork` to `MessagesTimelineProps` (`:151-172`):

```ts
  activeTurnStartedAt: string | null;
  backgroundWork: { count: number; oldestStartedAt: string } | null;
```

Destructure it in the `memo(function MessagesTimeline({ ... })` param list (`:178`).

Thread it into the `deriveMessagesTimelineRows` `useMemo` (`:268-289`) — add `backgroundWork,` to both the call arguments and the dependency array:

```tsx
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        expandedTurnIds,
        isWorking,
        activeTurnStartedAt,
        backgroundWork,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      latestTurn,
      expandedTurnIds,
      isWorking,
      activeTurnStartedAt,
      backgroundWork,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
```

Add the dispatch case alongside the working one (`:428-435`):

```tsx
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "background" ? <BackgroundTimelineRow row={row} /> : null}
```

Add the component next to `WorkingTimelineRow` (`:667`), reusing `WorkingTimer` (`:696`):

```tsx
function BackgroundTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "background" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-cyan-600/80 dark:text-cyan-300/70 tabular-nums">
        <span className="inline-flex size-3 items-center justify-center">
          <span className="size-1.5 rounded-full bg-cyan-500/70 dark:bg-cyan-300/60 animate-pulse" />
        </span>
        <span>
          {row.createdAt ? (
            <>
              Running in background for <WorkingTimer createdAt={row.createdAt} /> — resumes when it
              finishes
            </>
          ) : (
            "Running in background…"
          )}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Pass the prop from `ChatView`**

In `apps/web/src/components/ChatView.tsx`, add the prop to `<MessagesTimeline>` (`:4870-4892`), next to `activeTurnStartedAt` (`activeThread.session` is already in scope, `:1943`):

```tsx
                isWorking={isWorking}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnStartedAt={activeWorkStartedAt}
                backgroundWork={activeThread.session?.backgroundWork ?? null}
```

- [ ] **Step 7: Typecheck + full web tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm --filter @t3tools/web typecheck
pnpm --filter @t3tools/web test src/components/chat/MessagesTimeline.logic.test.ts
```
Expected: clean typecheck and PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/chat/MessagesTimeline.logic.ts \
        apps/web/src/components/chat/MessagesTimeline.logic.test.ts \
        apps/web/src/components/chat/MessagesTimeline.tsx \
        apps/web/src/components/ChatView.tsx
git commit -m "feat(web): add in-view background-work banner with wait timer"
```

---

## Final verification

- [ ] **Full typecheck + test sweep**

```bash
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:$PATH"
pnpm tc
pnpm --filter @t3tools/contracts test
pnpm --filter t3 test
pnpm --filter @t3tools/web test
```
Expected: all clean. Then confirm `grep -rn "hasPendingBackgroundWork" apps/ packages/` returns nothing.

- [ ] **Manual smoke (optional, via `/run` or daemon deploy):** launch a background Bash / `spawn_agent` / Workflow, end the turn, and confirm the sidebar shows the cyan pulsing "Background" pill and the chat shows the "Running in background for …" banner with a live timer; confirm both clear when the work finishes, and that the session is not reaped while pending.

---

## Notes for the implementer

- **Runtime `task_type` strings (open question):** the `taskTypeToBackgroundKind` mapper (Task 3) maps `shell`/`subagent`/`workflow`/`local_workflow`/`monitor` and falls back to `subagent`. `kind` is currently only informational (count is what gates the pill/reaper), so an unmapped type is harmless — but if kinds ever surface in the UI, verify the exact strings the daemon receives at runtime and extend the mapper.
- **Single ledger instance:** if a test or the runtime graph reports two different ledgers (e.g. the reaper sees pending work but ingestion doesn't), you have double-provided the layer — ensure `BackgroundWorkLedgerLive` is only in `OrchestrationLayerLive` (Task 2 Step 6) and every consumer just `yield*`s the tag.
- **Between-turns fiber uses `Stream.fromPubSub`** (Task 4), which subscribes lazily; a publish in the tiny window between fork and first pull at startup can be missed, but no session exists then, and the reaper + turn-boundary snapshot reads are authoritative — so this is safe. If you ever need it airtight, switch the fiber to `ledger.subscribeChanges` (synchronous acquire) + a `Queue.take` loop.
```
