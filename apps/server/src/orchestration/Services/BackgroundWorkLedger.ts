import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
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
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<ThreadId>, never, Scope.Scope>;
}

export class BackgroundWorkLedger extends Context.Service<
  BackgroundWorkLedger,
  BackgroundWorkLedgerShape
>()("t3/orchestration/Services/BackgroundWorkLedger") {}
