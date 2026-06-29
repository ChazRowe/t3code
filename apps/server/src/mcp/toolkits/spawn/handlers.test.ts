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
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import type { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderService } from "../../../provider/Services/ProviderService.ts";
import { makeSpawnAgentHandlers, MAX_SUBAGENT_DEPTH, SpawnAgentError } from "./handlers.ts";

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
  readonly dispatchSink: Array<OrchestrationCommand>;
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

  const providerService = {
    listSessions: () => Effect.succeed(options.sessions ?? [parentSession]),
    startSession: () => Effect.succeed(startedSession),
    sendTurn: () =>
      Effect.succeed({ threadId: "subagent-id-1", turnId: "turn-1" }) as unknown as ReturnType<
        typeof ProviderService.Service.sendTurn
      >,
    stopSession: () => Effect.void,
    streamEvents: Stream.fromIterable(options.events ?? []),
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
  };
};

const codexInstance = {
  instanceId: ProviderInstanceId.make("codex"),
  driverKind: "codex",
  displayName: "Codex",
} as unknown as ProviderInstance;

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
  }),
);
