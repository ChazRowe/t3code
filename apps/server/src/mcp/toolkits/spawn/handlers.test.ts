import { expect, it } from "@effect/vitest";
import type {
  OrchestrationCommand,
  ProviderRuntimeEvent,
  ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import type { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderService } from "../../../provider/Services/ProviderService.ts";
import { BackgroundWorkLedger } from "../../../orchestration/Services/BackgroundWorkLedger.ts";
import { makeBackgroundWorkLedgerLive } from "../../../orchestration/Layers/BackgroundWorkLedger.ts";
import { makeSpawnAgentHandlers, MAX_SUBAGENT_DEPTH, SpawnAgentError } from "./handlers.ts";

const noopLedger = {
  register: () => Effect.void,
  unregister: () => Effect.void,
  clearThread: () => Effect.void,
  snapshotFor: () => Effect.succeed(null),
  sweepBackstop: Effect.succeed([]),
  changes: Stream.empty,
  subscribeChanges: Effect.die("unused"),
} as unknown as typeof BackgroundWorkLedger.Service;

const PARENT_THREAD_ID = "thread-parent" as ThreadId;

// First UUID the deterministic crypto mock yields ("id-1") becomes the child thread id, so
// the agentId spawn_agent hands back — and that check_agent polls — is predictable.
const CHILD_AGENT_ID = "subagent-id-1";

const invocation = (subagentDepth: number): McpInvocationScope => ({
  environmentId: "env-1" as McpInvocationScope["environmentId"],
  threadId: PARENT_THREAD_ID,
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["spawn"]),
  subagentDepth,
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

// Deterministic, distinct UUIDs so the test can predict the generated child thread id.
const makeCrypto = () => {
  let counter = 0;
  return {
    randomUUIDv4: Effect.sync(() => `id-${++counter}`),
  } as unknown as typeof import("effect/Crypto").Crypto.Service;
};

const event = (threadId: string, type: string, payload: unknown): ProviderRuntimeEvent =>
  ({ threadId, type, payload }) as unknown as ProviderRuntimeEvent;

const makeDeps = (options: {
  readonly instance?: ProviderInstance | undefined;
  readonly events?: ReadonlyArray<ProviderRuntimeEvent>;
  readonly sessions?: ReadonlyArray<ProviderSession>;
  readonly sendTurnFails?: boolean;
  readonly dispatchSink: Array<OrchestrationCommand>;
  readonly backgroundWorkLedger?: typeof BackgroundWorkLedger.Service;
}): Parameters<typeof makeSpawnAgentHandlers>[0] => {
  const parentSession = {
    threadId: PARENT_THREAD_ID,
    runtimeMode: "full-access",
    cwd: "/work",
  } as unknown as ProviderSession;
  const startedSession = {
    provider: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("codex"),
    status: "ready",
    runtimeMode: "full-access",
    threadId: "subagent-id-1",
    model: "gpt-5-codex",
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  } as unknown as ProviderSession;

  // Mirror production faithfully: events flow through a real PubSub. The watcher subscribes
  // synchronously (before sending), then `sendTurn` publishes the seeded events — the same
  // ordering as a real provider streaming after the prompt is sent. This exercises the
  // `Stream.fromSubscription` path; a plain `Queue` mock would mask the Subscription-vs-Dequeue
  // bug it was written to catch.
  const runtimeEvents = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const providerService = {
    listSessions: () => Effect.succeed(options.sessions ?? [parentSession]),
    startSession: () => Effect.succeed(startedSession),
    sendTurn: () =>
      (options.sendTurnFails
        ? Effect.fail({ message: "provider rejected the prompt" })
        : PubSub.publishAll(runtimeEvents, options.events ?? []).pipe(
            Effect.as({ threadId: "subagent-id-1", turnId: "turn-1" }),
          )) as unknown as ReturnType<typeof ProviderService.Service.sendTurn>,
    stopSession: () => Effect.void,
    streamEvents: Stream.fromIterable(options.events ?? []),
    subscribeRuntimeEvents: PubSub.subscribe(runtimeEvents),
  } as unknown as typeof ProviderService.Service;

  const instanceRegistry = {
    getInstance: () => Effect.succeed(options.instance),
    listInstances: Effect.succeed(options.instance ? [options.instance] : []),
  } as unknown as typeof ProviderInstanceRegistry.Service;

  const orchestrationEngine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        options.dispatchSink.push(command);
        return { sequence: options.dispatchSink.length };
      }),
  } as unknown as typeof OrchestrationEngineService.Service;

  // Resolves both the parent thread (for project lookup) and the child thread (so the
  // projection-wait loop terminates immediately).
  const snapshotQuery = {
    getThreadShellById: () =>
      Effect.succeed(
        Option.some({
          id: PARENT_THREAD_ID,
          projectId: "project-1",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        }),
      ),
  } as unknown as typeof import("../../../orchestration/Services/ProjectionSnapshotQuery.ts").ProjectionSnapshotQuery.Service;

  return {
    providerService,
    instanceRegistry,
    orchestrationEngine,
    snapshotQuery,
    crypto: makeCrypto(),
    backgroundWorkLedger: options.backgroundWorkLedger ?? noopLedger,
  };
};

const instanceWithModels = (slugs: ReadonlyArray<string>): ProviderInstance =>
  ({
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: "codex",
    displayName: "Codex",
    // snapshot is a closure of effects; `getSnapshot` yields the ServerProvider
    // contract whose `models` array carries the valid slugs.
    snapshot: {
      getSnapshot: Effect.succeed({ models: slugs.map((slug) => ({ slug })) }),
    },
  }) as unknown as ProviderInstance;

const codexInstance = instanceWithModels(["gpt-5.5", "gpt-5.4"]);

// A provider whose model list is empty (e.g. lazy ACP discovery) — must not gate
// spawns or advertise models.
const noModelsInstance = instanceWithModels([]);

const appendedStatuses = (commands: ReadonlyArray<OrchestrationCommand>): Array<string> =>
  commands
    .filter((c) => c.type === "thread.activity.append")
    .map((c) => {
      const payload = (c as { activity: { payload: { status?: string } } }).activity.payload;
      return payload.status ?? "unknown";
    });

type PollOutcome =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "err"; readonly error: SpawnAgentError };

// spawn_agent now returns immediately and the turn is watched on a detached fiber, so poll
// check_agent (as the parent agent would) until it reports a terminal state.
const pollUntilTerminal = (
  checkAgent: ReturnType<typeof makeSpawnAgentHandlers>["checkAgent"],
  agentId: string,
): Effect.Effect<PollOutcome> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const outcome = yield* checkAgent({ agentId }, invocation(0)).pipe(
        Effect.map((text): PollOutcome => ({ kind: "ok", text })),
        Effect.catchTag("SpawnAgentError", (error) =>
          Effect.succeed<PollOutcome>({ kind: "err", error }),
        ),
      );
      if (outcome.kind === "err") return outcome;
      if (!outcome.text.includes("is still running")) return outcome;
      yield* Effect.sleep(Duration.millis(1));
    }
    return yield* Effect.die("watcher did not reach a terminal state");
  });

type DeliveredTurn = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

// The watcher dispatches the result-delivery turn right after it marks the job terminal, on
// its detached fiber — so poll the sink until it lands rather than reading it immediately.
const waitForDeliveredTurn = (
  dispatchSink: ReadonlyArray<OrchestrationCommand>,
): Effect.Effect<DeliveredTurn | undefined> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const found = dispatchSink.find((c) => c.type === "thread.turn.start");
      if (found) return found as DeliveredTurn;
      yield* Effect.sleep(Duration.millis(1));
    }
    return undefined;
  });

// it.live (real clock): spawn_agent watches the turn on a detached fiber and the poll loop
// sleeps between checks — both need wall-clock time, which the default TestClock would stall.
it.live("spawns in the background and returns the streamed text once polled", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({
      instance: codexInstance,
      dispatchSink,
      events: [
        event("subagent-id-1", "content.delta", { streamKind: "assistant_text", delta: "Hello " }),
        event("subagent-id-1", "content.delta", { streamKind: "assistant_text", delta: "world" }),
        event("subagent-id-1", "turn.completed", { state: "completed" }),
      ],
    });
    const { spawnAgent, checkAgent } = makeSpawnAgentHandlers(deps);

    // spawn_agent returns immediately with a handle to poll — it does not block on the turn.
    const handle = yield* spawnAgent(
      { providerInstanceId: "codex", prompt: "do the thing" },
      invocation(0),
    );
    expect(handle).toContain(CHILD_AGENT_ID);
    expect(handle).toContain("check_agent");

    const result = yield* pollUntilTerminal(checkAgent, CHILD_AGENT_ID);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.text).toBe("Hello world");

    // Node appended as inProgress, then transitioned to completed by the watcher.
    expect(appendedStatuses(dispatchSink)).toEqual(["inProgress", "completed"]);

    // The result is pushed back to the parent thread as a user turn — no polling needed.
    const delivered = yield* waitForDeliveredTurn(dispatchSink);
    expect(delivered?.threadId).toBe(PARENT_THREAD_ID);
    expect(delivered?.message.role).toBe("user");
    expect(delivered?.message.text).toContain("Hello world");
  }),
);

it.live("returns immediately and reports a send failure via check_agent + delivery", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    // No turn.completed event ever arrives; the only way out is the watcher observing the
    // failed sendTurn — which proves spawn_agent does not block on the send and still
    // finalizes the job (rather than waiting out SPAWN_MAX_WAIT).
    const deps = makeDeps({ instance: codexInstance, dispatchSink, sendTurnFails: true });
    const { spawnAgent, checkAgent } = makeSpawnAgentHandlers(deps);

    const handle = yield* spawnAgent(
      { providerInstanceId: "codex", prompt: "do the thing" },
      invocation(0),
    );
    expect(handle).toContain(CHILD_AGENT_ID);

    const result = yield* pollUntilTerminal(checkAgent, CHILD_AGENT_ID);
    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.error.message).toContain("Failed to send the prompt");
    }

    const delivered = yield* waitForDeliveredTurn(dispatchSink);
    expect(delivered?.threadId).toBe(PARENT_THREAD_ID);
    expect(delivered?.message.text).toContain("failed");
  }),
);

it.effect("reports unknown agent ids on check_agent", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({ instance: codexInstance, dispatchSink });
    const { checkAgent } = makeSpawnAgentHandlers(deps);

    const result = yield* checkAgent({ agentId: "subagent-nope" }, invocation(0)).pipe(Effect.flip);

    expect(result).toBeInstanceOf(SpawnAgentError);
    expect(result.message).toContain("Unknown agent");
  }),
);

it.effect("fails when the target provider instance is unknown", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({ instance: undefined, dispatchSink });
    const { spawnAgent } = makeSpawnAgentHandlers(deps);

    const result = yield* spawnAgent(
      { providerInstanceId: "nope", prompt: "x" },
      invocation(0),
    ).pipe(Effect.flip);

    expect(result).toBeInstanceOf(SpawnAgentError);
    expect(result.message).toContain("Unknown provider instance");
    // No session started, no node appended.
    expect(dispatchSink).toHaveLength(0);
  }),
);

it.effect("rejects spawning past the max subagent depth", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({ instance: codexInstance, dispatchSink });
    const { spawnAgent } = makeSpawnAgentHandlers(deps);

    const result = yield* spawnAgent(
      { providerInstanceId: "codex", prompt: "x" },
      invocation(MAX_SUBAGENT_DEPTH),
    ).pipe(Effect.flip);

    expect(result).toBeInstanceOf(SpawnAgentError);
    expect(result.message).toContain("depth limit");
    expect(dispatchSink).toHaveLength(0);
  }),
);

it.live("surfaces a failed turn state when the spawn is polled", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({
      instance: codexInstance,
      dispatchSink,
      events: [event("subagent-id-1", "turn.completed", { state: "failed" })],
    });
    const { spawnAgent, checkAgent } = makeSpawnAgentHandlers(deps);

    yield* spawnAgent({ providerInstanceId: "codex", prompt: "x" }, invocation(0));

    const result = yield* pollUntilTerminal(checkAgent, CHILD_AGENT_ID);
    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.error).toBeInstanceOf(SpawnAgentError);
      expect(result.error.message).toContain("ended with state 'failed'");
    }

    // The terminal node is still recorded on the parent, as failed.
    expect(appendedStatuses(dispatchSink)).toEqual(["inProgress", "failed"]);

    // The failure is delivered back to the parent thread too, not left for a poll.
    const delivered = yield* waitForDeliveredTurn(dispatchSink);
    expect(delivered?.threadId).toBe(PARENT_THREAD_ID);
    expect(delivered?.message.text).toContain("failed");
  }),
);

it.effect("list_agents surfaces each instance's available models", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({ instance: codexInstance, dispatchSink });
    const { listAgents } = makeSpawnAgentHandlers(deps);

    const text = yield* listAgents();

    expect(text).toContain("codex (provider: codex, name: Codex");
    expect(text).toContain("models: gpt-5.5, gpt-5.4");
  }),
);

it.effect("list_agents omits the models clause when none are advertised", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({ instance: noModelsInstance, dispatchSink });
    const { listAgents } = makeSpawnAgentHandlers(deps);

    const text = yield* listAgents();

    expect(text).toContain("codex (provider: codex, name: Codex)");
    expect(text).not.toContain("models:");
  }),
);

it.effect("rejects an unknown model override up front with the valid set", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({ instance: codexInstance, dispatchSink });
    const { spawnAgent } = makeSpawnAgentHandlers(deps);

    const result = yield* spawnAgent(
      { providerInstanceId: "codex", prompt: "x", model: "gpt-5.5-codex" },
      invocation(0),
    ).pipe(Effect.flip);

    expect(result).toBeInstanceOf(SpawnAgentError);
    expect(result.message).toContain("Unknown model 'gpt-5.5-codex'");
    expect(result.message).toContain("gpt-5.5, gpt-5.4");
    // Rejected before any session/node work.
    expect(dispatchSink).toHaveLength(0);
  }),
);

it.effect("does not gate the model when the instance advertises no models", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({ instance: noModelsInstance, dispatchSink });
    const { spawnAgent } = makeSpawnAgentHandlers(deps);

    // An arbitrary model id is accepted (reaches session start) rather than rejected,
    // because an empty list means "unknown", not "nothing is valid".
    const handle = yield* spawnAgent(
      { providerInstanceId: "codex", prompt: "x", model: "whatever-1.0" },
      invocation(0),
    );

    expect(handle).toContain(CHILD_AGENT_ID);
  }),
);

it.live("accepts a known model override and spawns", () =>
  Effect.gen(function* () {
    const dispatchSink: Array<OrchestrationCommand> = [];
    const deps = makeDeps({
      instance: codexInstance,
      dispatchSink,
      events: [event("subagent-id-1", "turn.completed", { state: "completed" })],
    });
    const { spawnAgent } = makeSpawnAgentHandlers(deps);

    const handle = yield* spawnAgent(
      { providerInstanceId: "codex", prompt: "x", model: "gpt-5.5" },
      invocation(0),
    );

    expect(handle).toContain(CHILD_AGENT_ID);
  }),
);

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
