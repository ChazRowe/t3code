import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND } from "./contextClearMarker.ts";

const now = "2026-01-01T00:00:00.000Z";
const asEventId = (s: string) => EventId.make(s);

const seedThread = Effect.fn(function* () {
  let model = createEmptyReadModel(now);
  model = yield* projectEvent(model, {
    sequence: 1,
    eventId: asEventId("e-proj"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("p1"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("c-proj"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId: ProjectId.make("p1"),
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
    aggregateId: ThreadId.make("t1"),
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("c-thread"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: ThreadId.make("t1"),
      projectId: ProjectId.make("p1"),
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
  return model;
});

const turnStart = (text: string): OrchestrationCommand =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make("c-turn"),
    threadId: ThreadId.make("t1"),
    message: { messageId: MessageId.make("m1"), role: "user", text, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: now,
  }) as OrchestrationCommand;

it.layer(NodeServices.layer)("decider /new context reset", (it) => {
  it.effect("intercepts /new into a context-cleared marker + resetContext stop", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread();
      const result = yield* decideOrchestrationCommand({ command: turnStart("/new"), readModel });
      const events = (Array.isArray(result) ? result : [result]) as ReadonlyArray<
        Omit<OrchestrationEvent, "sequence">
      >;

      // No turn is started and the command never lands in the chat timeline.
      const types = events.map((e) => e.type);
      expect(types).not.toContain("thread.turn-start-requested");
      expect(types).not.toContain("thread.message-sent");

      const marker = events.find((e) => e.type === "thread.activity-appended");
      expect(marker).toBeDefined();
      const activity = (marker!.payload as { activity: Record<string, unknown> }).activity;
      expect(activity.kind).toBe(PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND);
      expect(activity.summary).toBe("Context cleared");
      expect(activity.tone).toBe("info");
      expect(activity.turnId).toBeNull();
      expect(activity.payload).toEqual({ state: "cleared", trigger: "/new" });

      const stop = events.find((e) => e.type === "thread.session-stop-requested");
      expect(stop).toBeDefined();
      expect((stop!.payload as { resetContext?: boolean }).resetContext).toBe(true);
      // The stop is caused by the marker so the rebase boundary lands first.
      expect(stop!.causationEventId).toBe(marker!.eventId);
    }),
  );

  it.effect("treats normal text as an ordinary turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread();
      const result = yield* decideOrchestrationCommand({
        command: turnStart("please refactor this"),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      const types = events.map((e) => e.type);
      expect(types).toEqual(["thread.message-sent", "thread.turn-start-requested"]);
    }),
  );

  it.effect("does not match /news or /new-prefixed words", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread();
      for (const text of ["/news", "/newthread", "the /new command"]) {
        const result = yield* decideOrchestrationCommand({ command: turnStart(text), readModel });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((e) => e.type)).toEqual([
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
      }
    }),
  );

  it.effect("matches /new with leading whitespace or trailing text", () =>
    Effect.gen(function* () {
      const readModel = yield* seedThread();
      for (const text of ["  /new", "/new ", "/new now please"]) {
        const result = yield* decideOrchestrationCommand({ command: turnStart(text), readModel });
        const events = Array.isArray(result) ? result : [result];
        const types = events.map((e) => e.type);
        expect(types).toContain("thread.session-stop-requested");
        expect(types).not.toContain("thread.turn-start-requested");
      }
    }),
  );
});
