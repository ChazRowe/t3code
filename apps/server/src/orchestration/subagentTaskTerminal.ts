import type { OrchestrationSubagentStatus } from "@t3tools/contracts";

// A backgrounded/async `Agent` (Task) subagent returns its tool_result IMMEDIATELY — a
// launch receipt, not the subagent's completion. Its real lifecycle runs on the native
// task.* activity stream keyed by the embedded agentId (== taskId), so a backgrounded
// subagent's ONLY terminal signal is a terminal task.* activity: a task.completed, or a
// task.updated that killed/stopped/failed the task.
//
// Two independent consumers must agree on exactly which task.* rows are terminal:
//  - the RESOLVER: `ProjectionSnapshotQuery.getSubagentTree` derives a backgrounded ref's
//    status from these rows, and
//  - the TRIGGER: the `subscribeSubagentTree` live stream in `ws.ts`, which must recompute
//    and re-push the tree when one lands.
// If the two ever disagree, a backgrounded subagent finishes but the sidebar keeps showing
// it "inProgress" until the next unrelated ref event happens to trigger a recompute. This
// shared helper is the single source of truth, mirroring how `contextClearMarker.ts` keeps
// the context-clear resolver and trigger in lockstep.

/**
 * The terminal outcome a task.* activity row records for its taskId, or null when the row
 * is non-terminal (running / paused / backgrounded). task.completed is the authoritative
 * end; task.updated only terminates on killed / stopped / failed.
 */
export const taskRowTerminalStatus = (
  kind: string,
  status: unknown,
): OrchestrationSubagentStatus | null => {
  if (kind === "task.completed") {
    return status === "failed" || status === "stopped" ? "failed" : "completed";
  }
  if (kind === "task.updated") {
    return status === "failed" || status === "stopped" || status === "killed" ? "failed" : null;
  }
  return null;
};
