import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import {
  buildContextClearedSummary,
  buildUnattendedPreamble,
  CONTEXT_CLEARED_ACTIVITY_KIND,
  CONTINUE_MESSAGE,
  messageHasWrapSentinel,
} from "../unattendedRun.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  UnattendedRunReactor,
  type UnattendedRunReactorShape,
} from "../Services/UnattendedRunReactor.ts";

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
  readonly sawRunningSinceTurnStart: boolean;
}): TurnEndAction => {
  if (input.status === "error") return { kind: "fault", reason: "error" };
  if (input.status !== "idle" && input.status !== "ready") return { kind: "ignore" };
  // A freshly (re)created session passes through `ready`/`idle` while it warms up
  // for the next turn — BEFORE the agent has run. That is not a turn end. Only
  // treat idle/ready as a turn end once we've actually seen the turn running;
  // otherwise the warm-up status of each continued iteration is misread as an
  // empty turn and faults `no-sentinel`.
  if (!input.sawRunningSinceTurnStart) return { kind: "ignore" };
  // The final iteration's turn end ends the run whether or not it wrapped: there
  // is no further iteration to continue into, so a missing sentinel here means
  // "done" rather than "stopped early for a human". Mid-run, a sentinel-less
  // turn end IS the stop-for-human signal and pauses.
  if (input.currentIteration >= input.totalIterations) return { kind: "complete" };
  if (!input.hasSentinel) return { kind: "fault", reason: "no-sentinel" };
  return { kind: "clear-continue" };
};

const STOP_POLL_MAX_TRIES = 20;
const STOP_POLL_INTERVAL = Duration.millis(50);

class UnattendedRunStopTimeoutError extends Data.TaggedError(
  "UnattendedRunStopTimeoutError",
)<{
  readonly threadId: string;
}> {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const freshMessageId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => MessageId.make(`unattended:${uuid}`)),
  );
  const freshEventId = crypto.randomUUIDv4.pipe(Effect.map((uuid) => EventId.make(uuid)));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Per-thread accumulator of the latest assistant text (reset at turn start).
  const latestAssistantText = new Map<string, string>();
  // Per-thread flag: has the session reported `running` since the current turn
  // started? Distinguishes a real turn end (idle/ready after running) from a
  // freshly recreated session's warm-up status (idle/ready before running).
  const sawRunningSinceTurnStart = new Map<string, boolean>();
  // Per-thread latest reported context-window usage (from `context-window.updated`
  // activities), used to label the context-clear markers.
  const latestContextUsage = new Map<string, { usedTokens: number; maxTokens: number }>();
  // Per-thread flag: a clear just happened and we still owe a "fresh" marker for
  // the next context-window reading.
  const awaitingFreshContextReading = new Map<string, boolean>();

  const readThread = (threadId: string) =>
    projectionSnapshotQuery
      .getThreadDetailById(threadId as OrchestrationThread["id"])
      .pipe(Effect.map(Option.getOrUndefined));

  const issueContinueTurn = Effect.fn("issueContinueTurn")(function* (thread: OrchestrationThread) {
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("unattended-continue"),
      threadId: thread.id,
      message: {
        messageId: yield* freshMessageId,
        role: "user",
        text: CONTINUE_MESSAGE,
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: yield* nowIso,
    });
  });

  const dispatchFault = Effect.fn("dispatchFault")(function* (
    threadId: OrchestrationThread["id"],
    reason: "error" | "no-sentinel",
  ) {
    yield* orchestrationEngine.dispatch({
      type: "thread.unattended-run.fault",
      commandId: yield* serverCommandId("unattended-fault"),
      threadId,
      reason,
      createdAt: yield* nowIso,
    });
  });

  const readContextWindowUsage = (
    payload: unknown,
  ): { usedTokens: number; maxTokens: number } | undefined => {
    if (payload === null || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    const usedTokens = record.usedTokens;
    const maxTokens = record.maxTokens;
    if (typeof usedTokens === "number" && typeof maxTokens === "number" && maxTokens > 0) {
      return { usedTokens, maxTokens };
    }
    return undefined;
  };

  // Append a marker activity. Best-effort: a failure here must never fault or
  // stall the run, so non-interrupt causes are logged and swallowed.
  const appendMarker = (
    threadId: OrchestrationThread["id"],
    kind: string,
    summary: string,
    payload: unknown,
  ) =>
    Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("unattended-marker"),
        threadId,
        activity: {
          id: yield* freshEventId,
          tone: "info",
          kind,
          summary,
          payload,
          turnId: null,
          createdAt: yield* nowIso,
        },
        createdAt: yield* nowIso,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("unattended marker append failed", { cause: Cause.pretty(cause) }),
      ),
    );

  // Stop the session, wait for it to settle, advance the iteration, then re-arm
  // the loop with a continue turn. Any failure becomes a fault rather than an
  // unhandled defect.
  const clearAndContinue = Effect.fn("clearAndContinue")(function* (thread: OrchestrationThread) {
    yield* Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.session.stop",
        commandId: yield* serverCommandId("unattended-session-stop"),
        threadId: thread.id,
        createdAt: yield* nowIso,
      });

      const sessionStopped = (current: OrchestrationThread | undefined): boolean =>
        current === undefined ||
        current.session === null ||
        current.session.status === "stopped";

      let settled = false;
      for (let attempt = 0; attempt < STOP_POLL_MAX_TRIES; attempt++) {
        const current = yield* readThread(thread.id);
        if (sessionStopped(current)) {
          settled = true;
          break;
        }
        yield* Effect.sleep(STOP_POLL_INTERVAL);
      }
      if (!settled) {
        return yield* new UnattendedRunStopTimeoutError({ threadId: thread.id });
      }

      const clearedFrom = thread.unattendedRun?.currentIteration ?? 0;
      const clearedUsage = latestContextUsage.get(thread.id);
      yield* appendMarker(
        thread.id,
        CONTEXT_CLEARED_ACTIVITY_KIND,
        buildContextClearedSummary({
          fromIteration: clearedFrom,
          toIteration: clearedFrom + 1,
          ...(clearedUsage ?? {}),
        }),
        {
          fromIteration: clearedFrom,
          toIteration: clearedFrom + 1,
          ...(clearedUsage ?? {}),
        },
      );
      awaitingFreshContextReading.set(thread.id, true);

      yield* orchestrationEngine.dispatch({
        type: "thread.unattended-run.advance",
        commandId: yield* serverCommandId("unattended-advance"),
        threadId: thread.id,
        createdAt: yield* nowIso,
      });

      yield* issueContinueTurn(thread);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : dispatchFault(thread.id, "error"),
      ),
    );
  });

  const handleSessionSet = Effect.fn("handleSessionSet")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.session-set" }>,
  ) {
    const threadId = event.payload.threadId;
    const thread = yield* readThread(threadId);
    const run = thread?.unattendedRun;
    if (!thread || !run || run.status !== "running") {
      return;
    }

    if (event.payload.session.status === "running") {
      sawRunningSinceTurnStart.set(threadId, true);
    }

    const hasSentinel = messageHasWrapSentinel(latestAssistantText.get(threadId) ?? "");
    const action = decideTurnEndAction({
      status: event.payload.session.status,
      hasSentinel,
      currentIteration: run.currentIteration,
      totalIterations: run.totalIterations,
      sawRunningSinceTurnStart: sawRunningSinceTurnStart.get(threadId) ?? false,
    });

    switch (action.kind) {
      case "ignore":
        return;
      case "fault":
        return yield* dispatchFault(threadId, action.reason);
      case "complete":
        return yield* orchestrationEngine.dispatch({
          type: "thread.unattended-run.complete",
          commandId: yield* serverCommandId("unattended-complete"),
          threadId,
          createdAt: yield* nowIso,
        });
      case "clear-continue":
        return yield* clearAndContinue(thread);
    }
  });

  const processEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          latestAssistantText.set(event.payload.threadId, "");
          sawRunningSinceTurnStart.set(event.payload.threadId, false);
          return;
        }
        case "thread.message-sent": {
          if (event.payload.role !== "assistant") {
            return;
          }
          const threadId = event.payload.threadId;
          const previous = latestAssistantText.get(threadId) ?? "";
          latestAssistantText.set(threadId, previous + event.payload.text);
          return;
        }
        case "thread.activity-appended": {
          const activity = event.payload.activity;
          const threadId = event.payload.threadId;

          if (activity.kind === "context-window.updated") {
            const usage = readContextWindowUsage(activity.payload);
            if (usage) {
              latestContextUsage.set(threadId, usage);
            }
            return;
          }

          // The agent asked the human a question via an interactive tool
          // (AskUserQuestion). That SUSPENDS the turn waiting for an answer —
          // no turn-end (idle/ready) fires — so the no-sentinel pause path
          // never triggers and the run would hang. Pause it here for the human;
          // leave the session/turn suspended so they can answer in place, then
          // resume the run when ready.
          if (activity.kind !== "user-input.requested") {
            return;
          }
          const thread = yield* readThread(threadId);
          if (thread?.unattendedRun?.status !== "running") {
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.unattended-run.pause",
            commandId: yield* serverCommandId("unattended-await-input"),
            threadId: thread.id,
            reason: "awaiting-input",
            createdAt: yield* nowIso,
          });
          return;
        }
        case "thread.unattended-run-started": {
          const thread = yield* readThread(event.payload.threadId);
          if (!thread) {
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: yield* serverCommandId("unattended-preamble"),
            threadId: thread.id,
            message: {
              messageId: yield* freshMessageId,
              role: "user",
              text: buildUnattendedPreamble(event.payload.totalIterations),
              attachments: [],
            },
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: yield* nowIso,
          });
          return;
        }
        case "thread.session-set": {
          yield* handleSessionSet(event);
          return;
        }
        case "thread.turn-interrupt-requested": {
          const thread = yield* readThread(event.payload.threadId);
          if (thread?.unattendedRun?.status !== "running") {
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.unattended-run.pause",
            commandId: yield* serverCommandId("unattended-pause"),
            threadId: thread.id,
            createdAt: yield* nowIso,
          });
          return;
        }
        case "thread.unattended-run-resumed": {
          const thread = yield* readThread(event.payload.threadId);
          if (!thread) {
            return;
          }
          if (thread.session?.status === "running") {
            return;
          }
          yield* issueContinueTurn(thread);
          return;
        }
        default:
          return;
      }
    });

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("unattended run reactor failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const rehydrate = Effect.gen(function* () {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    yield* Effect.forEach(
      snapshot.threads.filter(
        (t) => t.unattendedRun?.status === "running" && t.session?.status !== "running",
      ),
      (thread) =>
        issueContinueTurn(thread).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("unattended run reactor rehydration failed", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  }).pipe(Effect.orDie);

  const start: UnattendedRunReactorShape["start"] = Effect.fn("start")(function* () {
    yield* rehydrate;
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => worker.enqueue(event)),
    );
  });

  return { start, drain: worker.drain } satisfies UnattendedRunReactorShape;
});

export const UnattendedRunReactorLive = Layer.effect(UnattendedRunReactor, make);

// Re-exported for unit testing pure helpers.
export const __test = { decideTurnEndAction };
