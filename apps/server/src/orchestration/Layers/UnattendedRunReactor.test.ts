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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { UnattendedRunReactor } from "../Services/UnattendedRunReactor.ts";
import { CONTINUE_MESSAGE, WRAP_SENTINEL } from "../unattendedRun.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { __test, UnattendedRunReactorLive } from "./UnattendedRunReactor.ts";

const { decideTurnEndAction } = __test;

describe("decideTurnEndAction", () => {
  it("error status faults with reason error", () => {
    expect(
      decideTurnEndAction({
        status: "error",
        hasSentinel: true,
        currentIteration: 1,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "fault", reason: "error" });
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

  it("idle without sentinel after the turn ran faults with reason no-sentinel", () => {
    expect(
      decideTurnEndAction({
        status: "idle",
        hasSentinel: false,
        currentIteration: 1,
        totalIterations: 3,
        sawRunningSinceTurnStart: true,
      }),
    ).toEqual({ kind: "fault", reason: "no-sentinel" });
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

const makeTestLayer = () => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
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
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
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

  return {
    readThread,
    startUnattendedRun,
    driveTurnEnd,
    emitSessionStatus,
    emitUserInputRequested,
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

effectIt.effect("pauses with no-sentinel when a turn ends without the wrap sentinel", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("nosentinel", "I need a human decision here.");

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.status, "paused");
    assert.strictEqual(thread?.unattendedRun?.pauseReason, "no-sentinel");
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

// The agent asks the human a question via an interactive tool (AskUserQuestion)
// instead of wrapping. That surfaces as a `user-input.requested` activity and
// SUSPENDS the turn — no turn-end (idle/ready) ever fires, so the run cannot
// rely on the no-sentinel turn-end path to pause. The reactor must pause the
// run on the activity itself, otherwise it hangs until a human intervenes.
effectIt.effect("pauses with awaiting-input when the agent requests user input mid-run", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(3);

    yield* harness.emitSessionStatus("running", "running");
    yield* harness.emitUserInputRequested("ask1");

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.status, "paused");
    assert.strictEqual(thread?.unattendedRun?.pauseReason, "awaiting-input");
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

effectIt.effect(
  "rehydrates a running unattended run with idle session when reactor starts",
  () =>
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
