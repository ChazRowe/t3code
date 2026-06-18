import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  type OrchestrationSession,
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
      }),
    ).toEqual({ kind: "complete" });
  });

  it("idle without sentinel faults with reason no-sentinel", () => {
    expect(
      decideTurnEndAction({
        status: "idle",
        hasSentinel: false,
        currentIteration: 1,
        totalIterations: 3,
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

  // Drive a turn end: record the assistant message, then flip the session to
  // idle (the real turn-end signal) and immediately to stopped so the reactor's
  // clear+continue poll can settle against the read model.
  const driveTurnEnd = (label: string, assistantText: string) =>
    Effect.gen(function* () {
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

  return { readThread, startUnattendedRun, driveTurnEnd };
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
