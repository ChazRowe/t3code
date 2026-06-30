import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyUnattendedRunEvent } from "./unattendedRun.ts";

const base = {
  sequence: 1,
  eventId: "e1",
  aggregateKind: "thread",
  aggregateId: "t1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const ev = (type: string, payload: unknown): OrchestrationEvent =>
  ({ ...base, type, payload }) as unknown as OrchestrationEvent;

describe("applyUnattendedRunEvent", () => {
  it("starts a run at iteration 1, status running", () => {
    const next = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 3,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    expect(next).toEqual({
      status: "running",
      totalIterations: 3,
      currentIteration: 1,
      pauseReason: null,
      startedAt: base.occurredAt,
      updatedAt: base.occurredAt,
    });
  });

  it("advances the iteration counter", () => {
    const started = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 3,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    const advanced = applyUnattendedRunEvent(
      started,
      ev("thread.unattended-run-iteration-advanced", {
        threadId: "t1",
        iteration: 2,
        updatedAt: "2026-01-01T00:01:00.000Z",
      }),
    );
    expect(advanced?.currentIteration).toBe(2);
    expect(advanced?.status).toBe("running");
  });

  it("pauses with a reason and resumes back to running", () => {
    let s = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 2,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    s = applyUnattendedRunEvent(
      s,
      ev("thread.unattended-run-paused", {
        threadId: "t1",
        reason: "no-sentinel",
        updatedAt: base.occurredAt,
      }),
    );
    expect(s).toMatchObject({ status: "paused", pauseReason: "no-sentinel" });
    s = applyUnattendedRunEvent(
      s,
      ev("thread.unattended-run-resumed", { threadId: "t1", updatedAt: base.occurredAt }),
    );
    expect(s).toMatchObject({ status: "running", pauseReason: null });
  });

  it("finishes (completed/stopped) and leaves a terminal state", () => {
    const started = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 1,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    const finished = applyUnattendedRunEvent(
      started,
      ev("thread.unattended-run-finished", {
        threadId: "t1",
        outcome: "completed",
        iteration: 1,
        updatedAt: base.occurredAt,
      }),
    );
    expect(finished).toMatchObject({ status: "completed" });
  });

  it("ignores unrelated events", () => {
    const started = applyUnattendedRunEvent(
      null,
      ev("thread.unattended-run-started", {
        threadId: "t1",
        totalIterations: 1,
        startedAt: base.occurredAt,
        updatedAt: base.occurredAt,
      }),
    );
    const same = applyUnattendedRunEvent(started, ev("thread.message-sent", { threadId: "t1" }));
    expect(same).toBe(started);
  });
});
