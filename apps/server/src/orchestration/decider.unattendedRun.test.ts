import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const asThreadId = (s: string) => ThreadId.make(s);
const asProjectId = (s: string) => ProjectId.make(s);
const asEventId = (s: string) => EventId.make(s);

const seedThread = Effect.fn(function* (opts: { started?: boolean; total?: number }) {
  let model = createEmptyReadModel(now);
  model = yield* projectEvent(model, {
    sequence: 1,
    eventId: asEventId("e-proj"),
    aggregateKind: "project",
    aggregateId: asProjectId("p1"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("c-proj"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId: asProjectId("p1"),
      title: "P",
      workspaceRoot: "/tmp/p",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  } as never);
  model = yield* projectEvent(model, {
    sequence: 2,
    eventId: asEventId("e-thread"),
    aggregateKind: "thread",
    aggregateId: asThreadId("t1"),
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("c-thread"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: asThreadId("t1"),
      projectId: asProjectId("p1"),
      title: "T",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  } as never);
  if (opts.started) {
    // Directly inject unattendedRun state since projector support comes in Task 9.
    model = {
      ...model,
      threads: model.threads.map((t) =>
        t.id === asThreadId("t1")
          ? {
              ...t,
              unattendedRun: {
                status: "running" as const,
                totalIterations: opts.total ?? 3,
                currentIteration: 1,
                pauseReason: null,
                startedAt: now,
                updatedAt: now,
              },
            }
          : t,
      ),
    };
  }
  return model;
});

it.layer(NodeServices.layer)("decider unattended run", (it) => {
  it.effect("start emits started", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({});
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.start",
          commandId: CommandId.make("c1"),
          threadId: asThreadId("t1"),
          totalIterations: 3,
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-started");
      expect((event.payload as { totalIterations: number }).totalIterations).toBe(3);
    }),
  );

  it.effect("start fails when a run is already active", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true });
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.unattended-run.start",
            commandId: CommandId.make("c2"),
            threadId: asThreadId("t1"),
            totalIterations: 2,
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("advance increments the iteration", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true, total: 3 });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.advance",
          commandId: CommandId.make("c3"),
          threadId: asThreadId("t1"),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-iteration-advanced");
      expect((event.payload as { iteration: number }).iteration).toBe(2);
    }),
  );

  it.effect("fault emits paused with the given reason", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.fault",
          commandId: CommandId.make("c4"),
          threadId: asThreadId("t1"),
          reason: "no-sentinel",
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-paused");
      expect((event.payload as { reason: string }).reason).toBe("no-sentinel");
    }),
  );

  it.effect("complete emits finished/completed", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.complete",
          commandId: CommandId.make("c5"),
          threadId: asThreadId("t1"),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-finished");
      expect((event.payload as { outcome: string }).outcome).toBe("completed");
    }),
  );

  it.effect("pause on a running run emits paused with reason manual", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true, total: 3 });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.pause",
          commandId: CommandId.make("c6"),
          threadId: asThreadId("t1"),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-paused");
      expect((event.payload as { reason: string }).reason).toBe("manual");
    }),
  );

  it.effect("stop on a running run emits finished/stopped with currentIteration", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true, total: 3 });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.stop",
          commandId: CommandId.make("c7"),
          threadId: asThreadId("t1"),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-finished");
      expect((event.payload as { outcome: string }).outcome).toBe("stopped");
      expect((event.payload as { iteration: number }).iteration).toBe(1);
    }),
  );

  it.effect("resume on a paused run emits resumed", () =>
    Effect.gen(function* () {
      let readModel = yield* seedThread({ started: true, total: 3 });
      // Inject paused state directly (projector support comes in Task 9).
      readModel = {
        ...readModel,
        threads: readModel.threads.map((t) =>
          t.id === asThreadId("t1")
            ? {
                ...t,
                unattendedRun: {
                  status: "paused" as const,
                  totalIterations: 3,
                  currentIteration: 1,
                  pauseReason: "no-sentinel" as const,
                  startedAt: now,
                  updatedAt: now,
                },
              }
            : t,
        ),
      };
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unattended-run.resume",
          commandId: CommandId.make("c8"),
          threadId: asThreadId("t1"),
          createdAt: now,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.unattended-run-resumed");
    }),
  );

  it.effect("resume on a running run fails", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({ started: true, total: 3 });
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.unattended-run.resume",
            commandId: CommandId.make("c9"),
            threadId: asThreadId("t1"),
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("stop on a thread with no run fails", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread({});
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.unattended-run.stop",
            commandId: CommandId.make("c10"),
            threadId: asThreadId("t1"),
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
