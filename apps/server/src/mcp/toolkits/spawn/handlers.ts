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
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import type { SpawnAgentParameters } from "./tools.ts";

// Bound recursive fan-out — matches Claude Code's native nested-subagent depth limit
// (5 levels below the user's top-level session).
export const MAX_SUBAGENT_DEPTH = 5;

// A spawned turn can run for minutes; cap the wait so a hung subagent doesn't pin the
// MCP request open forever. On timeout we return whatever text streamed so far plus the
// child thread id (the run stays inspectable in the watch view).
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

const firstLine = (text: string): string => {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
};

export const makeSpawnAgentHandlers = (deps: SpawnAgentDeps) => {
  const { providerService, instanceRegistry, orchestrationEngine, snapshotQuery, crypto } = deps;

  // UUID generation can technically fail with a PlatformError; in practice it does not,
  // and there is no meaningful recovery, so treat a failure as a defect.
  const randomId = crypto.randomUUIDv4.pipe(Effect.orDie);

  const nowIso = DateTime.now.pipe(Effect.map((dt) => IsoDateTime.make(DateTime.formatIso(dt))));

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

  const spawnAgent = (
    params: SpawnAgentParameters,
    invocation: McpInvocationScope,
  ): Effect.Effect<string, SpawnAgentError> =>
    Effect.scoped(
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
            message:
              "Could not resolve the calling thread to place the subagent under its project.",
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

        // Stop the spawned session when the tool call ends (success, error, or
        // interruption) so each spawn doesn't leak a live provider process.
        yield* Effect.addFinalizer(() =>
          providerService.stopSession({ threadId: childThreadId }).pipe(Effect.ignore),
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

        // Subscribe BEFORE sending the turn so no streamed output is missed, then watch
        // the child thread for assistant text and turn completion.
        const textRef = yield* Ref.make("");
        const done = yield* Deferred.make<string>();
        yield* Effect.forkScoped(
          Stream.runForEach(providerService.streamEvents, (event) => {
            if (event.threadId !== childThreadId) return Effect.void;
            if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
              return Ref.update(textRef, (text) => text + event.payload.delta);
            }
            if (event.type === "turn.completed") {
              return Deferred.succeed(done, event.payload.state);
            }
            return Effect.void;
          }),
        );

        yield* providerService.sendTurn({ threadId: childThreadId, input: params.prompt }).pipe(
          Effect.mapError(
            (error) =>
              new SpawnAgentError({
                message: `Failed to send prompt to ${params.providerInstanceId}: ${error.message}`,
              }),
          ),
        );

        const outcome = yield* Deferred.await(done).pipe(Effect.timeoutOption(SPAWN_MAX_WAIT));
        const finalText = yield* Ref.get(textRef);
        const completedAt = yield* nowIso;

        const timedOut = Option.isNone(outcome);
        const state = Option.getOrUndefined(outcome);
        const succeeded = state === "completed";

        yield* appendNode({
          parentThreadId: invocation.threadId,
          rootItemId,
          kind: succeeded ? "tool.completed" : "tool.failed",
          status: succeeded ? "completed" : "failed",
          summary,
          subagentType,
          prompt: params.prompt,
          description,
          childThreadId,
          providerInstanceId: targetInstanceId,
          provider,
          model: resolvedModel,
          resultText: finalText.length > 0 ? finalText : null,
          createdAt: completedAt,
        }).pipe(Effect.ignore);

        if (timedOut) {
          return (
            (finalText.length > 0 ? `${finalText}\n\n` : "") +
            `[spawn_agent timed out after ${Duration.toMillis(SPAWN_MAX_WAIT) / 60000} minutes; ` +
            `the subagent is still running on thread ${childThreadId}.]`
          );
        }
        if (!succeeded) {
          return yield* new SpawnAgentError({
            message: `Subagent turn ended with state '${state ?? "unknown"}'.`,
          });
        }
        return finalText;
      }),
    );

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

  return { spawnAgent, listAgents };
};
