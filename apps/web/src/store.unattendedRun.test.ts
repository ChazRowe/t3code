import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyOrchestrationEvent,
  selectThreadByRef,
  type AppState,
  type EnvironmentState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

const localEnvironmentId = EnvironmentId.make("environment-local");

function withActiveEnvironmentState(environmentState: EnvironmentState): AppState {
  return {
    activeEnvironmentId: localEnvironmentId,
    environmentStateById: {
      [localEnvironmentId]: environmentState,
    },
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    unattendedRun: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  const projectId = ProjectId.make("project-1");
  const project = {
    id: projectId,
    environmentId: thread.environmentId,
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    scripts: [],
  };
  const threadIdsByProjectId: EnvironmentState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  const environmentState: EnvironmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: project,
    },
    threadIds: [thread.id],
    threadIdsByProjectId,
    threadShellById: {
      [thread.id]: {
        id: thread.id,
        environmentId: thread.environmentId,
        codexThreadId: thread.codexThreadId,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        error: thread.error,
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        updatedAt: thread.updatedAt,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        unattendedRun: thread.unattendedRun,
      },
    },
    threadSessionById: {
      [thread.id]: thread.session,
    },
    threadTurnStateById: {
      [thread.id]: {
        latestTurn: thread.latestTurn,
        ...(thread.pendingSourceProposedPlan
          ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
          : {}),
      },
    },
    messageIdsByThreadId: {
      [thread.id]: thread.messages.map((message) => message.id),
    },
    messageByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.messages.map((message) => [message.id, message] as const),
      ) as EnvironmentState["messageByThreadId"][ThreadId],
    },
    activityIdsByThreadId: {
      [thread.id]: thread.activities.map((activity) => activity.id),
    },
    activityByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.activities.map((activity) => [activity.id, activity] as const),
      ) as EnvironmentState["activityByThreadId"][ThreadId],
    },
    proposedPlanIdsByThreadId: {
      [thread.id]: thread.proposedPlans.map((plan) => plan.id),
    },
    proposedPlanByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.proposedPlans.map((plan) => [plan.id, plan] as const),
      ) as EnvironmentState["proposedPlanByThreadId"][ThreadId],
    },
    turnDiffIdsByThreadId: {
      [thread.id]: thread.turnDiffSummaries.map((summary) => summary.turnId),
    },
    turnDiffSummaryByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
      ) as EnvironmentState["turnDiffSummaryByThreadId"][ThreadId],
    },
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  return withActiveEnvironmentState(environmentState);
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.make("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("unattended run store reducers", () => {
  const threadId = ThreadId.make("thread-1");
  const ref = scopeThreadRef(localEnvironmentId, threadId);

  it("starts with unattendedRun: null", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const result = selectThreadByRef(state, ref);

    expect(result?.unattendedRun).toBeNull();
  });

  it("thread.unattended-run-started sets status to 'running'", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const event = makeEvent("thread.unattended-run-started", {
      threadId,
      totalIterations: 5,
      startedAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
    });
    const next = applyOrchestrationEvent(state, event, localEnvironmentId);

    const result = selectThreadByRef(next, ref);
    expect(result?.unattendedRun?.status).toBe("running");
    expect(result?.unattendedRun?.totalIterations).toBe(5);
    expect(result?.unattendedRun?.currentIteration).toBe(1);
  });

  it("thread.unattended-run-iteration-advanced advances currentIteration", () => {
    const thread = makeThread({
      unattendedRun: {
        status: "running",
        totalIterations: 5,
        currentIteration: 1,
        pauseReason: null,
        startedAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      },
    });
    const state = makeState(thread);

    const event = makeEvent("thread.unattended-run-iteration-advanced", {
      threadId,
      iteration: 2,
      updatedAt: "2026-02-27T00:01:00.000Z",
    });
    const next = applyOrchestrationEvent(state, event, localEnvironmentId);

    const result = selectThreadByRef(next, ref);
    expect(result?.unattendedRun?.currentIteration).toBe(2);
  });

  it("thread.unattended-run-paused sets status to 'paused'", () => {
    const thread = makeThread({
      unattendedRun: {
        status: "running",
        totalIterations: 5,
        currentIteration: 2,
        pauseReason: null,
        startedAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
      },
    });
    const state = makeState(thread);

    const event = makeEvent("thread.unattended-run-paused", {
      threadId,
      reason: "no-sentinel",
      updatedAt: "2026-02-27T00:02:00.000Z",
    });
    const next = applyOrchestrationEvent(state, event, localEnvironmentId);

    const result = selectThreadByRef(next, ref);
    expect(result?.unattendedRun?.status).toBe("paused");
    expect(result?.unattendedRun?.pauseReason).toBe("no-sentinel");
  });

  it("thread.unattended-run-resumed sets status back to 'running'", () => {
    const thread = makeThread({
      unattendedRun: {
        status: "paused",
        totalIterations: 5,
        currentIteration: 2,
        pauseReason: "no-sentinel",
        startedAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:02:00.000Z",
      },
    });
    const state = makeState(thread);

    const event = makeEvent("thread.unattended-run-resumed", {
      threadId,
      updatedAt: "2026-02-27T00:03:00.000Z",
    });
    const next = applyOrchestrationEvent(state, event, localEnvironmentId);

    const result = selectThreadByRef(next, ref);
    expect(result?.unattendedRun?.status).toBe("running");
    expect(result?.unattendedRun?.pauseReason).toBeNull();
  });

  it("thread.unattended-run-finished sets status to outcome", () => {
    const thread = makeThread({
      unattendedRun: {
        status: "running",
        totalIterations: 5,
        currentIteration: 4,
        pauseReason: null,
        startedAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:04:00.000Z",
      },
    });
    const state = makeState(thread);

    const event = makeEvent("thread.unattended-run-finished", {
      threadId,
      outcome: "completed",
      iteration: 5,
      updatedAt: "2026-02-27T00:05:00.000Z",
    });
    const next = applyOrchestrationEvent(state, event, localEnvironmentId);

    const result = selectThreadByRef(next, ref);
    expect(result?.unattendedRun?.status).toBe("completed");
    expect(result?.unattendedRun?.currentIteration).toBe(5);
  });
});
