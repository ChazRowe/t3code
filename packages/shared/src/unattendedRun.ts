import type { OrchestrationEvent, UnattendedRunState } from "@t3tools/contracts";

/**
 * Fold an orchestration event into a thread's unattended-run state. Pure and
 * total: events that are not unattended-run events return `current` unchanged
 * (by reference, so callers can short-circuit). This is the single source of
 * truth shared by the in-memory projector, the SQL projection, and the web store.
 */
export const applyUnattendedRunEvent = (
  current: UnattendedRunState | null,
  event: OrchestrationEvent,
): UnattendedRunState | null => {
  switch (event.type) {
    case "thread.unattended-run-started":
      return {
        status: "running",
        totalIterations: event.payload.totalIterations,
        currentIteration: 1,
        pauseReason: null,
        startedAt: event.payload.startedAt,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unattended-run-iteration-advanced":
      if (current === null) return current;
      return {
        ...current,
        status: "running",
        currentIteration: event.payload.iteration,
        pauseReason: null,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unattended-run-paused":
      if (current === null) return current;
      return {
        ...current,
        status: "paused",
        pauseReason: event.payload.reason,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unattended-run-resumed":
      if (current === null) return current;
      return {
        ...current,
        status: "running",
        pauseReason: null,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.unattended-run-finished":
      if (current === null) return current;
      return {
        ...current,
        status: event.payload.outcome,
        currentIteration: event.payload.iteration,
        pauseReason: null,
        updatedAt: event.payload.updatedAt,
      };
    default:
      return current;
  }
};
