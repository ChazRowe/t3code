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
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import {
  buildUnattendedPreamble,
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
}): TurnEndAction => {
  if (input.status === "error") return { kind: "fault", reason: "error" };
  if (input.status !== "idle" && input.status !== "ready") return { kind: "ignore" };
  if (!input.hasSentinel) return { kind: "fault", reason: "no-sentinel" };
  return input.currentIteration < input.totalIterations
    ? { kind: "clear-continue" }
    : { kind: "complete" };
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
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Per-thread accumulator of the latest assistant text (reset at turn start).
  const latestAssistantText = new Map<string, string>();

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

    const hasSentinel = messageHasWrapSentinel(latestAssistantText.get(threadId) ?? "");
    const action = decideTurnEndAction({
      status: event.payload.session.status,
      hasSentinel,
      currentIteration: run.currentIteration,
      totalIterations: run.totalIterations,
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

  const start: UnattendedRunReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => worker.enqueue(event)),
    );
  });

  return { start, drain: worker.drain } satisfies UnattendedRunReactorShape;
});

export const UnattendedRunReactorLive = Layer.effect(UnattendedRunReactor, make);

// Re-exported for unit testing pure helpers.
export const __test = { decideTurnEndAction };
