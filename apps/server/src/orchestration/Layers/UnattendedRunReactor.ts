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
  buildContextFreshSummary,
  buildUnattendedPreamble,
  CONTEXT_CLEARED_ACTIVITY_KIND,
  CONTEXT_FRESH_ACTIVITY_KIND,
  CONTINUE_MESSAGE,
  messageHasWrapSentinel,
  resolveAppendedLastMessage,
  WRAP_SENTINEL,
} from "../unattendedRun.ts";
import { DEFAULT_SERVER_SETTINGS, type UnattendedRunSettings } from "@t3tools/contracts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  UnattendedRunReactor,
  type UnattendedRunReactorShape,
} from "../Services/UnattendedRunReactor.ts";

export type TurnEndAction =
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
  // Only a real turn end — the session leaving `running` for idle/ready — is a
  // turn-end signal. An errored session, or any other status, is left alone: the
  // reactor never auto-pauses, so the run simply stays running. (An error is
  // visible on the turn itself; the user decides what to do with it.)
  if (input.status !== "idle" && input.status !== "ready") return { kind: "ignore" };
  // A freshly (re)created session passes through `ready`/`idle` while it warms up
  // for the next turn — BEFORE the agent has run. That is not a turn end. Only
  // treat idle/ready as a turn end once we've actually seen the turn running;
  // otherwise the warm-up status of each continued iteration is misread as an
  // empty turn.
  if (!input.sawRunningSinceTurnStart) return { kind: "ignore" };
  // The final iteration's turn end completes the run: there is no further
  // iteration to continue into, so the iteration ceiling is the run's natural end.
  if (input.currentIteration >= input.totalIterations) return { kind: "complete" };
  // Mid-run without a sentinel: the agent has not asked to advance. Stay running
  // and do nothing — it may simply be waiting on background work it started, and
  // will emit the sentinel when it wants the next (cleared) iteration. Only the
  // sentinel advances the loop; only the user pauses or stops it.
  if (!input.hasSentinel) return { kind: "ignore" };
  return { kind: "clear-continue" };
};

/**
 * True when the just-completed turn's finalized assistant text carries the wrap
 * sentinel. Scoped to the thread's latest turn so a sentinel from a previous
 * iteration can never be mistaken for the current one.
 */
const projectionTurnHasWrapSentinel = (
  thread: OrchestrationThread,
  sentinel: string = WRAP_SENTINEL,
): boolean => {
  const turnId = thread.latestTurn?.turnId;
  if (!turnId) return false;
  return thread.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId &&
      messageHasWrapSentinel(message.text, sentinel),
  );
};

const STOP_POLL_MAX_TRIES = 20;
const STOP_POLL_INTERVAL = Duration.millis(50);

class UnattendedRunStopTimeoutError extends Data.TaggedError("UnattendedRunStopTimeoutError")<{
  readonly threadId: string;
}> {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettingsService = yield* ServerSettingsService;

  // Read the unattended-run config fresh; fall back to built-in defaults if the
  // settings read ever fails so a config error never faults a running loop.
  const readUnattendedConfig: Effect.Effect<UnattendedRunSettings> =
    serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
      Effect.map((settings) => settings.unattendedRun),
    );

  const effectiveSentinel = (cfg: UnattendedRunSettings): string => cfg.sentinel || WRAP_SENTINEL;

  const buildContinueText = (
    cfg: UnattendedRunSettings,
    appendedMessage: string | null,
  ): string => {
    const base = cfg.continueMessage || CONTINUE_MESSAGE;
    return appendedMessage ? `${base}\n\n${appendedMessage}` : base;
  };

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const freshMessageId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => MessageId.make(`unattended:${uuid}`)),
  );
  const freshEventId = crypto.randomUUIDv4.pipe(Effect.map((uuid) => EventId.make(uuid)));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Per-thread accumulator of the latest assistant text (reset at turn start).
  const latestAssistantText = new Map<string, string>();
  // Per-thread, per-iteration map of assistant messageId -> accumulated text.
  // `thread.message-sent` fires per streamed CHUNK reusing a messageId across a
  // message's chunks; keying by messageId reconstructs discrete messages. Reset
  // at the ITERATION boundary (run start + context clear), NOT at turn start, so
  // it captures every assistant message of an iteration that spans turns.
  const iterationAssistantMessages = new Map<string, Map<string, string>>();
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

  const issueContinueTurn = Effect.fn("issueContinueTurn")(function* (
    thread: OrchestrationThread,
    options?: { readonly cfg?: UnattendedRunSettings; readonly appendedMessage?: string | null },
  ) {
    const cfg = options?.cfg ?? (yield* readUnattendedConfig);
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("unattended-continue"),
      threadId: thread.id,
      message: {
        messageId: yield* freshMessageId,
        role: "user",
        text: buildContinueText(cfg, options?.appendedMessage ?? null),
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: yield* nowIso,
    });
  });

  // Only ever reached when clear-and-continue itself fails — a genuine internal
  // defect, not a routine turn end. Surfaces as a paused run so the operator can
  // see it; normal turn ends never fault.
  const dispatchFault = Effect.fn("dispatchFault")(function* (
    threadId: OrchestrationThread["id"],
    reason: "error",
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
  const clearAndContinue = Effect.fn("clearAndContinue")(function* (
    thread: OrchestrationThread,
    cfg: UnattendedRunSettings,
    appendedMessage: string | null,
  ) {
    yield* Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.session.stop",
        commandId: yield* serverCommandId("unattended-session-stop"),
        threadId: thread.id,
        // Forget the conversation so the next iteration starts with a fresh
        // context window instead of resuming the prior one.
        resetContext: true,
        createdAt: yield* nowIso,
      });

      const sessionStopped = (current: OrchestrationThread | undefined): boolean =>
        current === undefined || current.session === null || current.session.status === "stopped";

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
      const clearedFields = {
        fromIteration: clearedFrom,
        toIteration: clearedFrom + 1,
        ...latestContextUsage.get(thread.id),
      };
      yield* appendMarker(
        thread.id,
        CONTEXT_CLEARED_ACTIVITY_KIND,
        buildContextClearedSummary(clearedFields),
        clearedFields,
      );
      awaitingFreshContextReading.set(thread.id, true);
      iterationAssistantMessages.set(thread.id, new Map());

      yield* orchestrationEngine.dispatch({
        type: "thread.unattended-run.advance",
        commandId: yield* serverCommandId("unattended-advance"),
        threadId: thread.id,
        createdAt: yield* nowIso,
      });

      yield* issueContinueTurn(thread, { cfg, appendedMessage });
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

    const cfg = yield* readUnattendedConfig;
    const sentinel = effectiveSentinel(cfg);

    // Primary signal is the streamed accumulator, which the reactor's serial
    // worker fills from the turn's assistant message-sent events before it ever
    // processes this turn-end. The projection snapshot loaded above is a free
    // second source: if a late or missed stream append left the accumulator
    // empty, the finalized assistant text for the just-ended turn still catches
    // the sentinel. Scoped to the latest turn, so a prior iteration's sentinel
    // can't leak in.
    const hasSentinel =
      messageHasWrapSentinel(latestAssistantText.get(threadId) ?? "", sentinel) ||
      projectionTurnHasWrapSentinel(thread, sentinel);
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
      case "complete":
        return yield* orchestrationEngine.dispatch({
          type: "thread.unattended-run.complete",
          commandId: yield* serverCommandId("unattended-complete"),
          threadId,
          createdAt: yield* nowIso,
        });
      case "clear-continue": {
        const appendedMessage = cfg.appendLastAgentMessage
          ? resolveAppendedLastMessage(
              Array.from(iterationAssistantMessages.get(threadId)?.values() ?? []),
              sentinel,
            )
          : null;
        return yield* clearAndContinue(thread, cfg, appendedMessage);
      }
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

          const byId = iterationAssistantMessages.get(threadId) ?? new Map<string, string>();
          byId.set(
            event.payload.messageId,
            (byId.get(event.payload.messageId) ?? "") + event.payload.text,
          );
          iterationAssistantMessages.set(threadId, byId);
          return;
        }
        case "thread.activity-appended": {
          const activity = event.payload.activity;
          const threadId = event.payload.threadId;

          if (activity.kind === "context-window.updated") {
            const usage = readContextWindowUsage(activity.payload);
            if (!usage) {
              return;
            }
            latestContextUsage.set(threadId, usage);
            if (!awaitingFreshContextReading.get(threadId)) {
              return;
            }
            const thread = yield* readThread(threadId);
            if (thread?.unattendedRun?.status !== "running") {
              return;
            }
            awaitingFreshContextReading.set(threadId, false);
            const freshFields = {
              iteration: thread.unattendedRun.currentIteration,
              usedTokens: usage.usedTokens,
              maxTokens: usage.maxTokens,
            };
            yield* appendMarker(
              thread.id,
              CONTEXT_FRESH_ACTIVITY_KIND,
              buildContextFreshSummary(freshFields),
              freshFields,
            );
            return;
          }

          // Any other activity — including `user-input.requested` from
          // AskUserQuestion — is left alone. The agent is free to ask the human a
          // question and suspend its turn; the run stays running until the human
          // answers (and the agent later emits the sentinel) or the user pauses
          // or stops. The reactor never auto-pauses.
          return;
        }
        case "thread.unattended-run-started": {
          const thread = yield* readThread(event.payload.threadId);
          if (!thread) {
            return;
          }
          iterationAssistantMessages.set(thread.id, new Map());
          const cfg = yield* readUnattendedConfig;
          const preambleText =
            cfg.preamble ||
            buildUnattendedPreamble(
              event.payload.totalIterations,
              thread.modelSelection.model,
              effectiveSentinel(cfg),
            );
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: yield* serverCommandId("unattended-preamble"),
            threadId: thread.id,
            message: {
              messageId: yield* freshMessageId,
              role: "user",
              text: preambleText,
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
          // The user interrupted the streaming turn (the chat Stop button, which
          // is distinct from the unattended Pause button). That exits unattended
          // mode altogether rather than pausing: the turn is interrupted as usual
          // and the run terminates (stopped), leaving an ordinary thread the user
          // can drive directly or restart unattended afresh.
          yield* orchestrationEngine.dispatch({
            type: "thread.unattended-run.stop",
            commandId: yield* serverCommandId("unattended-interrupt-stop"),
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
export const __test = { decideTurnEndAction, projectionTurnHasWrapSentinel };
