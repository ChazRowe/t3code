import {
  CommandId,
  EventId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TrimmedNonEmptyString,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import type { CheckAgentParameters, SpawnAgentParameters } from "./tools.ts";

// Bound recursive fan-out — matches Claude Code's native nested-subagent depth limit
// (5 levels below the user's top-level session).
export const MAX_SUBAGENT_DEPTH = 5;

// A spawned turn can run for minutes. `spawn_agent` no longer blocks on it: the turn is
// watched on a detached background fiber so the MCP request returns immediately. This caps
// how long that background watcher waits before giving up — past it the run is marked timed
// out (the child thread stays inspectable in the watch view and may still be running).
const SPAWN_MAX_WAIT = Duration.minutes(30);

export class SpawnAgentError extends Data.TaggedError("SpawnAgentError")<{
  readonly message: string;
}> {}

export interface SpawnAgentDeps {
  readonly providerService: typeof ProviderService.Service;
  readonly instanceRegistry: typeof ProviderInstanceRegistry.Service;
  readonly orchestrationEngine: typeof OrchestrationEngineService.Service;
  readonly snapshotQuery: typeof ProjectionSnapshotQuery.Service;
  readonly crypto: typeof Crypto.Crypto.Service;
}

// Lifecycle of a backgrounded spawn, tracked in-memory so `check_agent` can report status
// without re-deriving it from the projection. "running" until the watcher observes the
// turn end (or `SPAWN_MAX_WAIT` elapses).
export type SpawnJobStatus = "running" | "completed" | "failed" | "timedOut";

export interface SpawnJob {
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly provider: string;
  readonly model: string | null;
  readonly description: string | null;
  readonly status: SpawnJobStatus;
  readonly resultText: string | null;
  readonly error: string | null;
  readonly startedAt: IsoDateTime;
  readonly completedAt: IsoDateTime | null;
}

const firstLine = (text: string): string => {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
};

const spawnMaxWaitMinutes = Duration.toMillis(SPAWN_MAX_WAIT) / 60000;

export const makeSpawnAgentHandlers = (deps: SpawnAgentDeps) => {
  const { providerService, instanceRegistry, orchestrationEngine, snapshotQuery, crypto } = deps;

  // UUID generation can technically fail with a PlatformError; in practice it does not,
  // and there is no meaningful recovery, so treat a failure as a defect.
  const randomId = crypto.randomUUIDv4.pipe(Effect.orDie);

  const nowIso = DateTime.now.pipe(Effect.map((dt) => IsoDateTime.make(DateTime.formatIso(dt))));

  // In-memory registry of backgrounded spawns, keyed by child thread id. A spawn lives for
  // the server process; the map is bounded by spawns-per-lifetime (small). Each job is
  // written once as "running", then transitioned to a terminal status by its watcher fiber.
  const jobs = new Map<string, SpawnJob>();
  const putJob = (job: SpawnJob): Effect.Effect<void> =>
    Effect.sync(() => {
      jobs.set(job.childThreadId, job);
    });
  const patchJob = (childThreadId: ThreadId, patch: Partial<SpawnJob>): Effect.Effect<void> =>
    Effect.sync(() => {
      const existing = jobs.get(childThreadId);
      if (existing) jobs.set(childThreadId, { ...existing, ...patch });
    });
  const readJob = (agentId: string): Effect.Effect<SpawnJob | undefined> =>
    Effect.sync(() => jobs.get(agentId));

  // Append (or update) the synthetic `collab_agent_tool_call` node on the PARENT thread.
  // Reusing the existing subagent-tree machinery means the watch UI nests the
  // cross-provider subagent under its caller with no query changes — the node carries
  // `childThreadId` so the transcript resolves from the child thread.
  const appendNode = (input: {
    readonly parentThreadId: ThreadId;
    readonly rootItemId: RuntimeItemId;
    readonly kind: string;
    readonly status: "inProgress" | "completed" | "failed";
    readonly summary: string;
    readonly subagentType: string;
    readonly prompt: string;
    readonly description: string | null;
    readonly childThreadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly provider: string;
    readonly model: string | null;
    readonly resultText: string | null;
    readonly createdAt: IsoDateTime;
  }) =>
    Effect.gen(function* () {
      const activityId = EventId.make(yield* randomId);
      const commandUuid = yield* randomId;
      const payload = {
        itemType: "collab_agent_tool_call",
        status: input.status,
        itemId: input.rootItemId,
        data: {
          input: {
            subagent_type: input.subagentType,
            prompt: input.prompt,
            ...(input.description !== null ? { description: input.description } : {}),
          },
          ...(input.resultText !== null ? { result: { content: input.resultText } } : {}),
        },
        subagentSession: {
          childThreadId: input.childThreadId,
          providerInstanceId: input.providerInstanceId,
          provider: input.provider,
          model: input.model,
        },
      };
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`spawn:${activityId}:${commandUuid}`),
        threadId: input.parentThreadId,
        activity: {
          id: activityId,
          tone: "tool",
          kind: input.kind,
          summary: input.summary,
          payload,
          turnId: null,
          itemId: input.rootItemId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    });

  // Poll (bounded) until the projection pipeline reflects a thread, swallowing query
  // errors and giving up after `attemptsLeft` tries (best-effort).
  const waitForThreadProjection = (
    threadId: ThreadId,
    attemptsLeft: number,
  ): Effect.Effect<void> => {
    if (attemptsLeft <= 0) return Effect.void;
    const retry = Effect.sleep(Duration.millis(50)).pipe(
      Effect.andThen(() => waitForThreadProjection(threadId, attemptsLeft - 1)),
    );
    return snapshotQuery.getThreadShellById(threadId).pipe(
      Effect.flatMap((shell) => (Option.isSome(shell) ? Effect.void : retry)),
      Effect.catch(() => retry),
    );
  };

  const createChildThread = (input: {
    readonly childThreadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly targetInstanceId: ProviderInstanceId;
    readonly model: string;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly createdAt: IsoDateTime;
  }) =>
    Effect.gen(function* () {
      const commandUuid = yield* randomId;
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`spawn-create:${input.childThreadId}:${commandUuid}`),
        threadId: input.childThreadId,
        projectId: input.projectId,
        title: TrimmedNonEmptyString.make(input.title),
        modelSelection: {
          instanceId: input.targetInstanceId,
          model: TrimmedNonEmptyString.make(input.model),
        },
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        parentThreadId: input.parentThreadId,
        createdAt: input.createdAt,
      });
    });

  // Watch a sent turn to completion on a detached fiber: accumulate streamed assistant
  // text, transition the parent's watch-tree node to its terminal state, record the result
  // in the job registry, and stop the child session. Runs to its own conclusion regardless
  // of whether (or when) the caller polls with `check_agent`, so a never-polled spawn still
  // finalizes its node and releases its provider process.
  const watchToCompletion = (input: {
    readonly parentThreadId: ThreadId;
    readonly childThreadId: ThreadId;
    readonly rootItemId: RuntimeItemId;
    readonly summary: string;
    readonly subagentType: string;
    readonly prompt: string;
    readonly description: string | null;
    readonly providerInstanceId: ProviderInstanceId;
    readonly provider: string;
    readonly model: string | null;
  }): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Subscribe BEFORE the caller sends the turn so no streamed output is missed, then
        // watch the child thread for assistant text and turn completion.
        const textRef = yield* Ref.make("");
        const done = yield* Deferred.make<string>();
        yield* Effect.forkScoped(
          Stream.runForEach(providerService.streamEvents, (event) => {
            if (event.threadId !== input.childThreadId) return Effect.void;
            if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
              return Ref.update(textRef, (text) => text + event.payload.delta);
            }
            if (event.type === "turn.completed") {
              return Deferred.succeed(done, event.payload.state);
            }
            return Effect.void;
          }),
        );

        const outcome = yield* Deferred.await(done).pipe(Effect.timeoutOption(SPAWN_MAX_WAIT));
        const finalText = yield* Ref.get(textRef);
        const completedAt = yield* nowIso;

        const timedOut = Option.isNone(outcome);
        const state = Option.getOrUndefined(outcome);
        const succeeded = state === "completed";

        yield* appendNode({
          parentThreadId: input.parentThreadId,
          rootItemId: input.rootItemId,
          kind: succeeded ? "tool.completed" : "tool.failed",
          status: succeeded ? "completed" : "failed",
          summary: input.summary,
          subagentType: input.subagentType,
          prompt: input.prompt,
          description: input.description,
          childThreadId: input.childThreadId,
          providerInstanceId: input.providerInstanceId,
          provider: input.provider,
          model: input.model,
          resultText: finalText.length > 0 ? finalText : null,
          createdAt: completedAt,
        }).pipe(Effect.ignore);

        yield* patchJob(input.childThreadId, {
          status: timedOut ? "timedOut" : succeeded ? "completed" : "failed",
          resultText: finalText.length > 0 ? finalText : null,
          error:
            timedOut || succeeded
              ? null
              : `Subagent turn ended with state '${state ?? "unknown"}'.`,
          completedAt,
        });
      }),
    ).pipe(
      // Stop the spawned session once the turn is done (or timed out / interrupted) so each
      // spawn doesn't leak a live provider process.
      Effect.ensuring(
        providerService.stopSession({ threadId: input.childThreadId }).pipe(Effect.ignore),
      ),
    );

  const spawnAgent = (
    params: SpawnAgentParameters,
    invocation: McpInvocationScope,
  ): Effect.Effect<string, SpawnAgentError> =>
    Effect.gen(function* () {
      if (invocation.subagentDepth >= MAX_SUBAGENT_DEPTH) {
        return yield* new SpawnAgentError({
          message:
            `Subagent depth limit reached (${MAX_SUBAGENT_DEPTH}). ` +
            "A subagent this deep may not spawn further subagents.",
        });
      }

      const targetInstanceId = ProviderInstanceId.make(params.providerInstanceId);
      const instance = yield* instanceRegistry.getInstance(targetInstanceId);
      if (!instance) {
        return yield* new SpawnAgentError({
          message:
            `Unknown provider instance '${params.providerInstanceId}'. ` +
            "Call list_agents to see available providerInstanceId values.",
        });
      }

      // Inherit the caller's safety envelope (runtime mode) and workspace (cwd) so a
      // delegated agent cannot exceed what the caller itself is permitted.
      const sessions = yield* providerService.listSessions();
      const parentSession = sessions.find((s) => s.threadId === invocation.threadId);
      if (!parentSession) {
        return yield* new SpawnAgentError({
          message: "Could not resolve the calling session to inherit its runtime mode.",
        });
      }
      const runtimeMode: RuntimeMode = parentSession.runtimeMode;

      // The child is a real thread under the caller's project; resolve it so the
      // child thread.create has a project to attach to and inherits branch/worktree.
      const parentShell = yield* snapshotQuery.getThreadShellById(invocation.threadId).pipe(
        Effect.mapError(
          (error) =>
            new SpawnAgentError({
              message: `Failed to resolve the calling thread: ${error.message ?? String(error)}`,
            }),
        ),
      );
      if (Option.isNone(parentShell)) {
        return yield* new SpawnAgentError({
          message: "Could not resolve the calling thread to place the subagent under its project.",
        });
      }
      const parent = parentShell.value;

      const childThreadId = ThreadId.make(`subagent-${yield* randomId}`);
      const rootItemId = RuntimeItemId.make(`spawn-${yield* randomId}`);
      const description = params.description ?? null;
      const subagentType = params.providerInstanceId;
      const summary = `${params.providerInstanceId}: ${description ?? firstLine(params.prompt)}`;
      const provider = instance.driverKind;

      const startedAt = yield* nowIso;

      // Start the child session, inheriting cwd/runtime mode and stamping the spawn
      // depth so the child's MCP credential bounds further recursion. Starting the
      // session dispatches no orchestration command, so the child thread need not
      // exist yet; its early lifecycle events are dropped until the thread is created
      // below, which is fine — the transcript we care about is the post-prompt turn.
      const session = yield* providerService
        .startSession(childThreadId, {
          threadId: childThreadId,
          providerInstanceId: targetInstanceId,
          runtimeMode,
          subagentDepth: invocation.subagentDepth + 1,
          ...(parentSession.cwd !== undefined ? { cwd: parentSession.cwd } : {}),
          ...(params.model !== undefined
            ? { modelSelection: { instanceId: targetInstanceId, model: params.model } }
            : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SpawnAgentError({
                message: `Failed to start ${params.providerInstanceId} session: ${error.message}`,
              }),
          ),
        );

      const resolvedModel = session.model ?? params.model ?? null;

      // Create the child's orchestration thread under the parent's project so its
      // runtime events are accepted by ingestion (which drops events for unknown
      // threads). Marked with parentThreadId so it stays out of the top-level shell
      // snapshot and is reachable only via the parent's subagent tree.
      yield* createChildThread({
        childThreadId,
        parentThreadId: invocation.threadId,
        projectId: parent.projectId,
        title: summary,
        targetInstanceId,
        model: resolvedModel ?? provider,
        runtimeMode,
        interactionMode: parent.interactionMode,
        branch: parent.branch,
        worktreePath: parent.worktreePath,
        createdAt: startedAt,
      }).pipe(Effect.ignore);

      // Wait (bounded) for the projection pipeline to reflect the new thread before
      // sending the turn, so the turn's activities aren't dropped by ingestion.
      yield* waitForThreadProjection(childThreadId, 100);

      yield* appendNode({
        parentThreadId: invocation.threadId,
        rootItemId,
        kind: "tool.updated",
        status: "inProgress",
        summary,
        subagentType,
        prompt: params.prompt,
        description,
        childThreadId,
        providerInstanceId: targetInstanceId,
        provider,
        model: resolvedModel,
        resultText: null,
        createdAt: startedAt,
      }).pipe(Effect.ignore);

      yield* putJob({
        parentThreadId: invocation.threadId,
        childThreadId,
        providerInstanceId: targetInstanceId,
        provider,
        model: resolvedModel,
        description,
        status: "running",
        resultText: null,
        error: null,
        startedAt,
        completedAt: null,
      });

      // Fork the watcher BEFORE sending the turn (so its stream subscription is live) onto
      // a detached fiber that outlives this MCP request — that is what makes spawn_agent
      // non-blocking. The watcher owns the child session from here on.
      const watcherFiber = yield* Effect.forkDetach(
        watchToCompletion({
          parentThreadId: invocation.threadId,
          childThreadId,
          rootItemId,
          summary,
          subagentType,
          prompt: params.prompt,
          description,
          providerInstanceId: targetInstanceId,
          provider,
          model: resolvedModel,
        }),
      );

      yield* providerService.sendTurn({ threadId: childThreadId, input: params.prompt }).pipe(
        Effect.mapError(
          (error) =>
            new SpawnAgentError({
              message: `Failed to send prompt to ${params.providerInstanceId}: ${error.message}`,
            }),
        ),
        // If the prompt never lands, tear the watcher down (its finalizer stops the
        // session) and mark the job failed so a stray poll sees a coherent terminal state.
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* Fiber.interrupt(watcherFiber);
            const failedAt = yield* nowIso;
            yield* patchJob(childThreadId, {
              status: "failed",
              error: "Failed to send the prompt to the subagent.",
              completedAt: failedAt,
            });
          }).pipe(Effect.ignore),
        ),
      );

      return (
        `Spawned a subagent on ${provider} (instance ${params.providerInstanceId}). ` +
        `It is running in the background as agent "${childThreadId}". ` +
        `Call check_agent with agentId "${childThreadId}" about once a minute to poll for ` +
        "completion; it reports that the subagent is still running until the turn finishes, " +
        "then returns the subagent's final response."
      );
    });

  const checkAgent = (
    params: CheckAgentParameters,
    invocation: McpInvocationScope,
  ): Effect.Effect<string, SpawnAgentError> =>
    Effect.gen(function* () {
      const agentId = params.agentId;
      const job = yield* readJob(agentId);
      if (!job) {
        return yield* new SpawnAgentError({
          message: `Unknown agent '${agentId}'. Pass the agentId returned by spawn_agent.`,
        });
      }
      // A session may only poll subagents it spawned.
      if (job.parentThreadId !== invocation.threadId) {
        return yield* new SpawnAgentError({
          message: `Agent '${agentId}' was not spawned by this session.`,
        });
      }

      switch (job.status) {
        case "running":
          return (
            `Subagent '${agentId}' on ${job.provider} is still running (started ${job.startedAt}). ` +
            "Call check_agent again in about a minute."
          );
        case "completed":
          return job.resultText !== null && job.resultText.length > 0
            ? job.resultText
            : `Subagent '${agentId}' completed but produced no text output.`;
        case "timedOut":
          return (
            (job.resultText !== null && job.resultText.length > 0
              ? `${job.resultText}\n\n`
              : "") +
            `[Subagent '${agentId}' timed out after ${spawnMaxWaitMinutes} minutes; ` +
            `it may still be running on thread ${job.childThreadId}.]`
          );
        case "failed":
          return yield* new SpawnAgentError({
            message:
              (job.error ?? `Subagent '${agentId}' ended in a failed state.`) +
              (job.resultText !== null && job.resultText.length > 0
                ? `\n\nPartial output:\n${job.resultText}`
                : ""),
          });
      }
    });

  const listAgents = (): Effect.Effect<string, SpawnAgentError> =>
    instanceRegistry.listInstances.pipe(
      Effect.map((instances) =>
        instances.length === 0
          ? "No provider instances are configured."
          : instances
              .map((instance) => {
                const name = instance.displayName ?? instance.instanceId;
                return `${instance.instanceId} (provider: ${instance.driverKind}, name: ${name})`;
              })
              .join("\n"),
      ),
    );

  return { spawnAgent, checkAgent, listAgents };
};
