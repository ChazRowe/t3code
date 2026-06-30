import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationSession,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import type { DeepPartial } from "@t3tools/shared/Struct";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { UnattendedRunReactor } from "../Services/UnattendedRunReactor.ts";
import { CONTEXT_FRESH_ACTIVITY_KIND, CONTINUE_MESSAGE, WRAP_SENTINEL } from "../unattendedRun.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { __test, UnattendedRunReactorLive } from "./UnattendedRunReactor.ts";

const { decideTurnEndAction, projectionTurnHasWrapSentinel } = __test;

describe("projectionTurnHasWrapSentinel", () => {
  const makeThread = (
    latestTurnId: string | null,
    messages: ReadonlyArray<{ role: "assistant" | "user"; turnId: string | null; text: string }>,
  ): OrchestrationThread =>
    ({
      latestTurn: latestTurnId === null ? null : { turnId: TurnId.make(latestTurnId) },
      messages: messages.map((message) => ({
        role: message.role,
        text: message.text,
        turnId: message.turnId === null ? null : TurnId.make(message.turnId),
      })),
    }) as unknown as OrchestrationThread;

  it("matches the sentinel in the latest turn's assistant text", () => {
    const thread = makeThread("turn-2", [
      { role: "assistant", turnId: "turn-2", text: `wrapped up\n${WRAP_SENTINEL}` },
    ]);
    expect(projectionTurnHasWrapSentinel(thread)).toBe(true);
  });

  it("ignores a sentinel from a previous turn (no cross-iteration leak)", () => {
    const thread = makeThread("turn-2", [
      { role: "assistant", turnId: "turn-1", text: `older wrap\n${WRAP_SENTINEL}` },
      { role: "assistant", turnId: "turn-2", text: "still working" },
    ]);
    expect(projectionTurnHasWrapSentinel(thread)).toBe(false);
  });

  it("ignores the sentinel in a user message", () => {
    const thread = makeThread("turn-2", [
      { role: "user", turnId: "turn-2", text: `please emit ${WRAP_SENTINEL}` },
    ]);
    expect(projectionTurnHasWrapSentinel(thread)).toBe(false);
  });

  it("returns false when there is no latest turn to scope to", () => {
    const thread = makeThread(null, [
      { role: "assistant", turnId: null, text: `done\n${WRAP_SENTINEL}` },
    ]);
    expect(projectionTurnHasWrapSentinel(thread)).toBe(false);
  });
});

describe("decideTurnEndAction", () => {
  it("error status is ignored — the reactor never auto-pauses, so the run stays running", () => {
    expect(
      decideTurnEndAction({
        status: "error",
        hasSentinel: false,
        currentIteration: 1,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("running status is ignored", () => {
    expect(
      decideTurnEndAction({
        status: "running",
        hasSentinel: true,
        currentIteration: 1,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("stopped status is ignored", () => {
    expect(
      decideTurnEndAction({
        status: "stopped",
        hasSentinel: true,
        currentIteration: 1,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("interrupted status is ignored", () => {
    expect(
      decideTurnEndAction({
        status: "interrupted",
        hasSentinel: false,
        currentIteration: 1,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("ready before the turn has run (session warm-up) is ignored", () => {
    expect(
      decideTurnEndAction({
        status: "ready",
        hasSentinel: false,
        currentIteration: 2,
        totalIterations: 5,
        sawRunningSinceTurnStart: false,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("idle before the turn has run (session warm-up) is ignored", () => {
    expect(
      decideTurnEndAction({
        status: "idle",
        hasSentinel: false,
        currentIteration: 2,
        totalIterations: 5,
        sawRunningSinceTurnStart: false,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("idle with sentinel mid-run clears and continues", () => {
    expect(
      decideTurnEndAction({
        status: "idle",
        hasSentinel: true,
        currentIteration: 1,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "clear-continue" });
  });

  it("idle with sentinel on the last iteration completes", () => {
    expect(
      decideTurnEndAction({
        status: "idle",
        hasSentinel: true,
        currentIteration: 3,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "complete" });
  });

  it("without sentinel on the last iteration completes (final turn end ends the run)", () => {
    expect(
      decideTurnEndAction({
        status: "idle",
        hasSentinel: false,
        currentIteration: 3,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "complete" });
  });

  it("idle without sentinel mid-run is ignored — the run stays running until the agent emits the sentinel", () => {
    expect(
      decideTurnEndAction({
        status: "idle",
        hasSentinel: false,
        currentIteration: 1,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("ready with sentinel mid-run clears and continues", () => {
    expect(
      decideTurnEndAction({
        status: "ready",
        hasSentinel: true,
        currentIteration: 1,
        totalIterations: 2,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "clear-continue" });
  });
});

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const makeTestLayer = (unattendedRun: DeepPartial<ServerSettings["unattendedRun"]> = {}) => {
  // Hoist the event store onto a single layer reference so the engine writes to
  // it AND the test can read it back (Effect memoizes by reference, the same way
  // the projection below shares the engine's persistence).
  const eventStoreLayer = OrchestrationEventStoreLive;
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(eventStoreLayer),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  return UnattendedRunReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(eventStoreLayer.pipe(Layer.provide(SqlitePersistenceMemory))),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest({ unattendedRun })),
    Layer.provideMerge(NodeServices.layer),
  );
};

const buildSession = (status: OrchestrationSession["status"]): OrchestrationSession => ({
  threadId,
  status,
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
});

// Builds project + thread, starts the reactor fiber in the test scope, and
// returns helpers that dispatch through the engine and drain the reactor.
const setupHarness = Effect.fn("setupHarness")(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const reactor = yield* UnattendedRunReactor;

  yield* reactor.start();

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project-create"),
    projectId,
    title: "Unattended Project",
    workspaceRoot: "/tmp/unattended-project",
    defaultModelSelection: modelSelection,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread-create"),
    threadId,
    projectId,
    title: "Thread",
    modelSelection,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: now,
  });

  const readThread = snapshotQuery
    .getThreadDetailById(threadId)
    .pipe(Effect.map(Option.getOrUndefined));

  const startUnattendedRun = (totalIterations: 1 | 2 | 3) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.unattended-run.start",
        commandId: CommandId.make(`cmd-unattended-start-${totalIterations}`),
        threadId,
        totalIterations,
        createdAt: now,
      });
      yield* reactor.drain;
    });

  // Emit a single session status transition and let the reactor process it.
  const emitSessionStatus = (label: string, status: OrchestrationSession["status"]) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-session-${status}-${label}`),
        threadId,
        session: buildSession(status),
        createdAt: now,
      });
      yield* reactor.drain;
    });

  // Drive a turn end the way a real provider does: the session goes `running`
  // (the turn is actually executing), the assistant streams its message, then
  // the session flips to idle (the real turn-end signal) and immediately to
  // stopped so the reactor's clear+continue poll can settle against the read
  // model.
  const driveTurnEnd = (label: string, assistantText: string) =>
    Effect.gen(function* () {
      yield* emitSessionStatus(label, "running");

      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`cmd-assistant-${label}`),
        threadId,
        messageId: MessageId.make(`assistant-${label}`),
        delta: assistantText,
        createdAt: now,
      });
      yield* reactor.drain;

      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-session-idle-${label}`),
        threadId,
        session: buildSession("idle"),
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-session-stopped-${label}`),
        threadId,
        session: buildSession("stopped"),
        createdAt: now,
      });
      yield* reactor.drain;
    });

  // Emit a `user-input.requested` activity the way the provider does when the
  // agent asks the human a question via an interactive tool (AskUserQuestion).
  // This suspends the turn rather than ending it — there is no turn-end signal.
  const emitUserInputRequested = (label: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`cmd-activity-${label}`),
        threadId,
        activity: {
          id: EventId.make(`activity-${label}`),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { questions: [] },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      });
      yield* reactor.drain;
    });

  // Emit the user's turn interrupt (the chat Stop button) via the command path,
  // which the decider turns into a `thread.turn-interrupt-requested` event.
  const emitTurnInterrupt = (label: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`cmd-interrupt-${label}`),
        threadId,
        createdAt: now,
      });
      yield* reactor.drain;
    });

  // Emit a `context-window.updated` activity the way the provider does as token
  // usage is reported during a turn.
  const emitContextWindowUpdated = (label: string, usedTokens: number, maxTokens: number) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`cmd-ctx-${label}`),
        threadId,
        activity: {
          id: EventId.make(`ctx-${label}`),
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload: { usedTokens, maxTokens },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      });
      yield* reactor.drain;
    });

  return {
    readThread,
    startUnattendedRun,
    driveTurnEnd,
    emitSessionStatus,
    emitUserInputRequested,
    emitTurnInterrupt,
    emitContextWindowUpdated,
  };
});

effectIt.effect("issues a preamble turn when the unattended run starts", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.status, "running");
    assert.strictEqual(thread?.unattendedRun?.currentIteration, 1);
    const userMessages = thread?.messages.filter((message) => message.role === "user") ?? [];
    assert.strictEqual(userMessages.length, 1);
    assert.ok(userMessages[0]?.text.includes("UNATTENDED run of 2 iteration(s)"));
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

effectIt.effect("advances and continues when a turn ends with the wrap sentinel", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("wrap", `done for now\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.status, "running");
    assert.strictEqual(thread?.unattendedRun?.currentIteration, 2);
    const userMessages = thread?.messages.filter((message) => message.role === "user") ?? [];
    assert.strictEqual(userMessages.length, 2);
    assert.ok(userMessages[1]?.text.includes("continue"));
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

effectIt.effect("clears context on continue by requesting a resetContext session stop", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("wrap", `done for now\n${WRAP_SENTINEL}`);

    // The clear-and-continue path must stop the session asking to forget the
    // conversation, so the next iteration starts with a fresh context window
    // rather than resuming the prior one.
    const eventStore = yield* OrchestrationEventStore;
    const events = yield* Stream.runCollect(eventStore.readAll());
    const stopRequests = Array.from(events).filter(
      (event) => event.type === "thread.session-stop-requested",
    );
    assert.strictEqual(stopRequests.length, 1);
    assert.strictEqual((stopRequests[0]?.payload as { resetContext?: boolean }).resetContext, true);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

// A mid-run turn that ends without the sentinel no longer pauses: the agent may
// simply be letting background work it started run to completion. The run stays
// running and idle, holding its iteration, until the agent emits the sentinel
// (to advance) or the user pauses/stops.
effectIt.effect("stays running when a mid-run turn ends without the wrap sentinel", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd(
      "nosentinel",
      "Kicked off a subagent; ending my turn to let it run.",
    );

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.status, "running");
    assert.strictEqual(thread?.unattendedRun?.pauseReason ?? null, null);
    assert.strictEqual(thread?.unattendedRun?.currentIteration, 1);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

// Regression: a continued iteration recreates the provider session, which emits
// a warm-up `ready` BEFORE the turn runs. That must NOT be read as an empty
// turn end and pause the run. (Previously every iteration >= 2 faulted
// `no-sentinel` on this warm-up status.)
effectIt.effect("does not fault on the warm-up ready of a freshly continued iteration", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(3);

    // Iteration 1 ends cleanly → advance to iteration 2 and issue a continue turn.
    yield* harness.driveTurnEnd("iter1", `wrap one\n${WRAP_SENTINEL}`);
    const advanced = yield* harness.readThread;
    assert.strictEqual(advanced?.unattendedRun?.currentIteration, 2);
    assert.strictEqual(advanced?.unattendedRun?.status, "running");

    // The recreated session reports `ready` while warming up, before any output.
    yield* harness.emitSessionStatus("warmup", "ready");

    const afterWarmup = yield* harness.readThread;
    assert.strictEqual(afterWarmup?.unattendedRun?.status, "running");
    assert.strictEqual(afterWarmup?.unattendedRun?.pauseReason ?? null, null);

    // And the iteration still completes normally once it actually runs.
    yield* harness.driveTurnEnd("iter2", `wrap two\n${WRAP_SENTINEL}`);
    const afterSecond = yield* harness.readThread;
    assert.strictEqual(afterSecond?.unattendedRun?.currentIteration, 3);
    assert.strictEqual(afterSecond?.unattendedRun?.status, "running");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

effectIt.effect("completes after the final iteration ends with the wrap sentinel", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("iter1", `wrap one\n${WRAP_SENTINEL}`);
    const afterFirst = yield* harness.readThread;
    assert.strictEqual(afterFirst?.unattendedRun?.currentIteration, 2);

    yield* harness.driveTurnEnd("iter2", `wrap two\n${WRAP_SENTINEL}`);
    const afterSecond = yield* harness.readThread;
    assert.strictEqual(afterSecond?.unattendedRun?.status, "completed");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

// A run that finishes its work on the LAST iteration omits the sentinel (work is
// done, nothing to continue into). That final sentinel-less turn end completes
// the run rather than pausing it `no-sentinel`.
effectIt.effect("completes when the final iteration ends without the wrap sentinel", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("iter1", `wrap one\n${WRAP_SENTINEL}`);
    yield* harness.driveTurnEnd("iter2", "All done — STATUS: COMPLETE, no sentinel.");

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.status, "completed");
    assert.strictEqual(thread?.unattendedRun?.pauseReason ?? null, null);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

// The agent asks the human a question via an interactive tool (AskUserQuestion),
// which surfaces as a `user-input.requested` activity and SUSPENDS the turn. The
// reactor must NOT pause: the run stays running while the turn waits in place for
// the human, who answers when they return (the agent then emits the sentinel to
// advance, or the user pauses/stops). The reactor never auto-pauses.
effectIt.effect("stays running when the agent requests user input mid-run (no auto-pause)", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(3);

    yield* harness.emitSessionStatus("running", "running");
    yield* harness.emitUserInputRequested("ask1");

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.status, "running");
    assert.strictEqual(thread?.unattendedRun?.pauseReason ?? null, null);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

// The user interrupts the streaming turn (the chat Stop button, which is distinct
// from the unattended Pause button). That exits unattended mode altogether: the
// run terminates (stopped) rather than pausing, leaving an ordinary thread the
// user can drive directly or restart unattended afresh.
effectIt.effect("stops the run when the user interrupts the turn (exits unattended mode)", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(3);

    yield* harness.emitSessionStatus("running", "running");
    yield* harness.emitTurnInterrupt("stop1");

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.status, "stopped");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

effectIt.effect("emits a context-cleared marker with the last usage when an iteration clears", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(3);

    yield* harness.emitContextWindowUpdated("iter1", 517_000, 1_000_000);
    yield* harness.driveTurnEnd("iter1", `wrap one\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    const cleared = thread?.activities.filter((a) => a.kind === "unattended.context-cleared") ?? [];
    assert.strictEqual(cleared.length, 1);
    assert.ok(cleared[0]?.summary.includes("iteration 1 → 2"), cleared[0]?.summary);
    assert.ok(cleared[0]?.summary.includes("517k"), cleared[0]?.summary);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

effectIt.effect("emits exactly one fresh-context marker on the first usage after a clear", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(3);

    yield* harness.emitContextWindowUpdated("iter1", 517_000, 1_000_000);
    yield* harness.driveTurnEnd("iter1", `wrap one\n${WRAP_SENTINEL}`);

    // The fresh session (iteration 2) reports its first, small usage.
    yield* harness.emitContextWindowUpdated("fresh", 4_000, 1_000_000);

    let thread = yield* harness.readThread;
    let fresh = thread?.activities.filter((a) => a.kind === CONTEXT_FRESH_ACTIVITY_KIND) ?? [];
    assert.strictEqual(fresh.length, 1);
    assert.ok(fresh[0]?.summary.includes("iteration 2"), fresh[0]?.summary);
    assert.ok(fresh[0]?.summary.includes("4k"), fresh[0]?.summary);

    // A second usage update within the same iteration must NOT add another marker.
    yield* harness.emitContextWindowUpdated("fresh2", 9_000, 1_000_000);
    thread = yield* harness.readThread;
    fresh = thread?.activities.filter((a) => a.kind === CONTEXT_FRESH_ACTIVITY_KIND) ?? [];
    assert.strictEqual(fresh.length, 1);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

// A `user-input.requested` activity outside a running unattended run (ordinary
// interactive use, or an already-paused run) must not touch run state.
effectIt.effect("ignores user-input.requested when no unattended run is active", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();

    yield* harness.emitUserInputRequested("ask-no-run");

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun ?? null, null);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

effectIt.effect("rehydrates a running unattended run with idle session when reactor starts", () =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const reactor = yield* UnattendedRunReactor;

    // Seed persistence: create project + thread + start an unattended run.
    // The reactor has NOT started yet, so no preamble turn is issued and no
    // session is created — the thread has unattendedRun.status === "running"
    // with session === null.
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-rehydrate-project"),
      projectId,
      title: "Rehydrate Project",
      workspaceRoot: "/tmp/rehydrate-project",
      defaultModelSelection: modelSelection,
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-rehydrate-thread"),
      threadId,
      projectId,
      title: "Rehydrate Thread",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    yield* engine.dispatch({
      type: "thread.unattended-run.start",
      commandId: CommandId.make("cmd-rehydrate-run-start"),
      threadId,
      totalIterations: 2,
      createdAt: now,
    });

    // Confirm the thread has a running unattended run with no active session.
    const beforeStart = yield* snapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    assert.strictEqual(beforeStart?.unattendedRun?.status, "running");
    assert.isNull(beforeStart?.session ?? null);

    // Now start the reactor — rehydration should issue a continue turn.
    yield* reactor.start();
    yield* reactor.drain;

    const afterStart = yield* snapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    const userMessages = afterStart?.messages.filter((m) => m.role === "user") ?? [];
    assert.ok(
      userMessages.some((m) => m.text === CONTINUE_MESSAGE),
      `expected a continue turn; got ${userMessages.length} user message(s)`,
    );
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);

const threadId2 = ThreadId.make("thread-2");

// Build a layer identical to makeTestLayer() except the ProjectionSnapshotQuery
// wraps getSnapshot() to prepend a ghost thread whose ID does not exist in the
// real engine. When the reactor rehydrates, dispatching issueContinueTurn for
// the ghost thread fails (OrchestrationCommandInvariantError via the engine),
// exercising the per-thread catchCause isolation introduced in Task 14.
const makeTestLayerWithGhostThread = () => {
  const ghostThread: OrchestrationThread = {
    id: ThreadId.make("ghost-thread-nonexistent"),
    projectId,
    title: "Ghost Thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    unattendedRun: {
      status: "running",
      totalIterations: 2,
      currentIteration: 1,
      pauseReason: null,
      startedAt: now,
      updatedAt: now,
    },
  };

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  const realSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  // Wrap the real snapshot query so getSnapshot() prepends the ghost thread.
  const wrappedSnapshotLayer = Layer.effect(
    ProjectionSnapshotQuery,
    Effect.gen(function* () {
      const real = yield* ProjectionSnapshotQuery;
      return {
        ...real,
        getSnapshot: () =>
          real.getSnapshot().pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              threads: [ghostThread, ...snapshot.threads],
            })),
          ),
      };
    }),
  ).pipe(Layer.provide(realSnapshotLayer));

  return UnattendedRunReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(wrappedSnapshotLayer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(NodeServices.layer),
  );
};

effectIt.effect(
  "rehydration is per-thread isolated: first thread failure does not skip second thread",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const reactor = yield* UnattendedRunReactor;

      // Seed a real project and thread-2 with a running unattended run.
      // The reactor has NOT started yet. The wrapped snapshot layer will also
      // inject a ghost thread (thread-1) that does not exist in the engine,
      // so its issueContinueTurn dispatch will fail.
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-isolation-project"),
        projectId,
        title: "Isolation Project",
        workspaceRoot: "/tmp/isolation-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-isolation-thread2"),
        threadId: threadId2,
        projectId,
        title: "Thread 2",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.unattended-run.start",
        commandId: CommandId.make("cmd-isolation-run2"),
        threadId: threadId2,
        totalIterations: 2,
        createdAt: now,
      });

      // Confirm thread-2 has a running unattended run with no session.
      const before2 = yield* snapshotQuery
        .getThreadDetailById(threadId2)
        .pipe(Effect.map(Option.getOrUndefined));
      assert.strictEqual(before2?.unattendedRun?.status, "running");
      assert.isNull(before2?.session ?? null);

      // Start the reactor. The wrapped getSnapshot() returns [ghost, thread-2].
      // Ghost dispatch fails → per-thread catchCause logs and continues.
      // Thread-2 dispatch succeeds → continue turn is issued.
      yield* reactor.start();
      yield* reactor.drain;

      const after2 = yield* snapshotQuery
        .getThreadDetailById(threadId2)
        .pipe(Effect.map(Option.getOrUndefined));
      const userMessages2 = after2?.messages.filter((m) => m.role === "user") ?? [];
      assert.ok(
        userMessages2.some((m) => m.text === CONTINUE_MESSAGE),
        `expected thread-2 to receive a continue turn despite ghost thread failure; got ${userMessages2.length} user message(s)`,
      );
    }).pipe(Effect.provide(Layer.fresh(makeTestLayerWithGhostThread()))),
);

effectIt.effect("uses a custom preamble verbatim when one is configured", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    const thread = yield* harness.readThread;
    const userMessages = thread?.messages.filter((m) => m.role === "user") ?? [];
    assert.strictEqual(userMessages.length, 1);
    assert.strictEqual(userMessages[0]?.text, "CUSTOM PREAMBLE");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ preamble: "CUSTOM PREAMBLE" })))),
);

effectIt.effect("advances on a configured custom sentinel (not the default)", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("custom", "work done\n<<DONE>>");

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.currentIteration, 2);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ sentinel: "<<DONE>>" })))),
);

effectIt.effect("does not advance on the default sentinel when a custom one is configured", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("default", `work done\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.currentIteration, 1);
    assert.strictEqual(thread?.unattendedRun?.status, "running");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ sentinel: "<<DONE>>" })))),
);

effectIt.effect("uses a custom continue message verbatim when configured", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("wrap", `done\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    const userMessages = thread?.messages.filter((m) => m.role === "user") ?? [];
    // Positional indexing (userMessages[1]) is avoided because the fixed `now`
    // constant makes all messages share the same createdAt, so tie-breaking by id
    // makes preamble vs. continue order nondeterministic across test runs.
    const continueMessage = userMessages.find((m) => m.text === "RESUME NOW");
    assert.ok(continueMessage, "expected a continue turn with the custom text");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ continueMessage: "RESUME NOW" })))),
);

effectIt.effect(
  "appends the last assistant message (sentinel stripped) when the toggle is on",
  () =>
    Effect.gen(function* () {
      const harness = yield* setupHarness();
      yield* harness.startUnattendedRun(2);

      yield* harness.driveTurnEnd("wrap", `did real work\n${WRAP_SENTINEL}`);

      const thread = yield* harness.readThread;
      const userMessages = thread?.messages.filter((m) => m.role === "user") ?? [];
      const continueText = userMessages.find((m) => m.text.includes(CONTINUE_MESSAGE))?.text ?? "";
      assert.ok(continueText.includes(CONTINUE_MESSAGE), continueText);
      assert.ok(continueText.endsWith("\n\ndid real work"), continueText);
      assert.ok(!continueText.includes(WRAP_SENTINEL), continueText);
    }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ appendLastAgentMessage: true })))),
);

effectIt.effect("does not append the last assistant message when the toggle is off", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("wrap", `did real work\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    const userMessages = thread?.messages.filter((m) => m.role === "user") ?? [];
    const continueMessage = userMessages.find((m) => m.text.includes(CONTINUE_MESSAGE));
    assert.strictEqual(continueMessage?.text, CONTINUE_MESSAGE);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);
