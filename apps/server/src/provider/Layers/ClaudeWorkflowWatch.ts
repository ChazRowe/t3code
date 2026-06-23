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
