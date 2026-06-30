// Pure parsing + reconciliation for Claude Code `Workflow`-tool runs. No Effect,
// no FileSystem — the ClaudeAdapter wires these into a forked watcher fiber.

export interface WorkflowLaunch {
  readonly runId: string;
  readonly transcriptDir: string;
  readonly taskId: string | undefined;
}

const RUN_ID_RE = /Run ID:\s*(wf_[A-Za-z0-9_-]+)/;
const TRANSCRIPT_DIR_RE = /Transcript dir:\s*(\S+)/;
const TASK_ID_RE = /Task ID:\s*(\S+)/;

/**
 * Parse the in-band `Workflow` tool_result text. Returns the run identity, or
 * undefined when the text is not a workflow launch (no Run ID / Transcript dir).
 */
export function parseWorkflowLaunch(text: string): WorkflowLaunch | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const runId = RUN_ID_RE.exec(text)?.[1];
  const transcriptDir = TRANSCRIPT_DIR_RE.exec(text)?.[1];
  if (!runId || !transcriptDir) {
    return undefined;
  }
  return {
    runId,
    transcriptDir,
    taskId: TASK_ID_RE.exec(text)?.[1],
  };
}

export interface WorkflowAgentInfo {
  readonly agentId: string;
  readonly label: string;
  readonly model: string | undefined;
  readonly tokens: number | undefined;
  readonly phase: string | undefined;
}

export interface WorkflowRunSnapshot {
  readonly status: string | undefined;
  readonly terminal: boolean;
  readonly summary: string | undefined;
  readonly agents: ReadonlyArray<WorkflowAgentInfo>;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "aborted",
]);

const EMPTY_SNAPSHOT: WorkflowRunSnapshot = {
  status: undefined,
  terminal: false,
  summary: undefined,
  agents: [],
};

/**
 * Normalize a parsed `workflows/wf_<runId>.json`. Tolerant of missing/partial
 * shapes (a half-written file during a poll) — unknown input yields an empty,
 * non-terminal snapshot so the watcher simply tries again on the next poll.
 */
export function parseWorkflowRunFile(raw: unknown): WorkflowRunSnapshot {
  if (typeof raw !== "object" || raw === null) {
    return EMPTY_SNAPSHOT;
  }
  const obj = raw as Record<string, unknown>;
  const status = typeof obj.status === "string" ? obj.status : undefined;
  const summary = typeof obj.summary === "string" ? obj.summary : undefined;
  const progress = Array.isArray(obj.workflowProgress) ? obj.workflowProgress : [];

  const agents: Array<WorkflowAgentInfo> = [];
  let currentPhase: string | undefined;
  for (const entry of progress) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.type === "workflow_phase") {
      if (typeof e.title === "string") {
        currentPhase = e.title;
      }
      continue;
    }
    if (e.type === "workflow_agent" && typeof e.agentId === "string") {
      agents.push({
        agentId: e.agentId,
        label: typeof e.label === "string" && e.label.length > 0 ? e.label : e.agentId,
        model: typeof e.model === "string" ? e.model : undefined,
        tokens: typeof e.tokens === "number" ? e.tokens : undefined,
        phase: currentPhase,
      });
    }
  }

  return {
    status,
    terminal: status !== undefined && TERMINAL_STATUSES.has(status),
    summary,
    agents,
  };
}

export type WorkflowAgentLifecycle = "started" | "completed";

export interface WorkflowJournalState {
  readonly statuses: ReadonlyMap<string, WorkflowAgentLifecycle>;
  readonly resultSummaries: ReadonlyMap<string, string>;
}

export interface MergedWorkflowAgent {
  readonly info: WorkflowAgentInfo;
  readonly status: WorkflowAgentLifecycle;
  readonly resultSummary: string | undefined;
}

const MAX_RESULT_SUMMARY = 400;

function summarizeJournalResult(result: unknown): string | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result === "string") {
    return result.slice(0, MAX_RESULT_SUMMARY);
  }
  try {
    return JSON.stringify(result).slice(0, MAX_RESULT_SUMMARY);
  } catch {
    return undefined;
  }
}

/**
 * Fold `journal.jsonl` lines into the latest lifecycle per agentId. A `result`
 * line always wins (terminal); a `started` line only sets status if none seen.
 * Malformed/blank lines are skipped (partial-write tolerance).
 */
export function parseWorkflowJournalLines(lines: ReadonlyArray<string>): WorkflowJournalState {
  const statuses = new Map<string, WorkflowAgentLifecycle>();
  const resultSummaries = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof evt !== "object" || evt === null) {
      continue;
    }
    const e = evt as Record<string, unknown>;
    const agentId = typeof e.agentId === "string" ? e.agentId : undefined;
    if (!agentId) {
      continue;
    }
    if (e.type === "result") {
      statuses.set(agentId, "completed");
      const summary = summarizeJournalResult(e.result);
      if (summary !== undefined) {
        resultSummaries.set(agentId, summary);
      }
    } else if (e.type === "started") {
      if (!statuses.has(agentId)) {
        statuses.set(agentId, "started");
      }
    }
  }
  return { statuses, resultSummaries };
}

/**
 * Union of agents known from the run file (rich: label/model/tokens/phase) and
 * agents seen live in the journal. Status comes from the journal; an agent that
 * appears only in the run file is treated as "started" until its result lands.
 */
export function mergeWorkflowAgents(
  snapshot: WorkflowRunSnapshot,
  journal: WorkflowJournalState,
): ReadonlyArray<MergedWorkflowAgent> {
  const byId = new Map<string, WorkflowAgentInfo>();
  for (const agent of snapshot.agents) {
    byId.set(agent.agentId, agent);
  }
  for (const agentId of journal.statuses.keys()) {
    if (!byId.has(agentId)) {
      byId.set(agentId, {
        agentId,
        label: agentId,
        model: undefined,
        tokens: undefined,
        phase: undefined,
      });
    }
  }
  const merged: Array<MergedWorkflowAgent> = [];
  for (const [agentId, info] of byId) {
    merged.push({
      info,
      status: journal.statuses.get(agentId) ?? "started",
      resultSummary: journal.resultSummaries.get(agentId),
    });
  }
  return merged;
}

export interface WorkflowReconcileResult {
  readonly toStart: ReadonlyArray<MergedWorkflowAgent>;
  readonly toComplete: ReadonlyArray<MergedWorkflowAgent>;
  readonly emitted: ReadonlySet<string>;
}

/**
 * Diff the merged agent set against the keys already emitted, returning only the
 * new start/complete intentions. Idempotent: re-running with the same (or a
 * superset) input produces empty lists once everything has settled.
 */
export function reconcileWorkflowAgents(
  emitted: ReadonlySet<string>,
  merged: ReadonlyArray<MergedWorkflowAgent>,
): WorkflowReconcileResult {
  const next = new Set(emitted);
  const toStart: Array<MergedWorkflowAgent> = [];
  const toComplete: Array<MergedWorkflowAgent> = [];
  for (const agent of merged) {
    const startKey = `start:${agent.info.agentId}`;
    const doneKey = `done:${agent.info.agentId}`;
    if (!next.has(startKey)) {
      toStart.push(agent);
      next.add(startKey);
    }
    if (agent.status === "completed" && !next.has(doneKey)) {
      toComplete.push(agent);
      next.add(doneKey);
    }
  }
  return { toStart, toComplete, emitted: next };
}

/** Fold the workflow phase into the agent label as a "type: description" pair. */
export function formatWorkflowAgentLabel(info: WorkflowAgentInfo): string {
  return info.phase ? `${info.phase}: ${info.label}` : info.label;
}
