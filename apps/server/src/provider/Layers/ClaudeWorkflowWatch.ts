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
        label:
          typeof e.label === "string" && e.label.length > 0 ? e.label : e.agentId,
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
