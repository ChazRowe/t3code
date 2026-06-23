import { assert, describe, it } from "@effect/vitest";

import { parseWorkflowLaunch, parseWorkflowRunFile } from "./ClaudeWorkflowWatch.ts";

const BACKGROUND_RESULT = `Workflow launched in background. Task ID: w4h1ox7dc
Summary: Deep parallel mapping of 3 realization-wiring lanes
Transcript dir: /home/chaz/.claude/projects/-proj/81dfefa6/subagents/workflows/wf_adfba522-74f
Script file: /tmp/wf-understand.js
Run ID: wf_adfba522-74f
To resume after editing the script: Workflow({scriptPath: "/tmp/wf-understand.js", resumeFromRunId: "wf_adfba522-74f"})

You will be notified when it completes. Use /workflows to watch live progress.`;

describe("parseWorkflowLaunch", () => {
  it("extracts runId, transcriptDir, and taskId from a background launch result", () => {
    const launch = parseWorkflowLaunch(BACKGROUND_RESULT);
    assert.deepEqual(launch, {
      runId: "wf_adfba522-74f",
      transcriptDir:
        "/home/chaz/.claude/projects/-proj/81dfefa6/subagents/workflows/wf_adfba522-74f",
      taskId: "w4h1ox7dc",
    });
  });

  it("returns undefined when the required lines are absent", () => {
    assert.equal(parseWorkflowLaunch("some unrelated tool result"), undefined);
    assert.equal(parseWorkflowLaunch(""), undefined);
  });

  it("parses even when no Task ID line is present", () => {
    const text = `Transcript dir: /a/b/subagents/workflows/wf_x1\nRun ID: wf_x1`;
    assert.deepEqual(parseWorkflowLaunch(text), {
      runId: "wf_x1",
      transcriptDir: "/a/b/subagents/workflows/wf_x1",
      taskId: undefined,
    });
  });
});

describe("parseWorkflowRunFile", () => {
  const RUN = {
    runId: "wf_26b9a7ea-142",
    status: "completed",
    summary: "Adversarial review",
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Review" },
      { type: "workflow_agent", index: 1, label: "grant_adjunct-failclosed", agentId: "a1385c15bd4ffd5af", model: "claude-opus-4-8[1m]", tokens: 120436 },
      { type: "workflow_agent", index: 2, label: "contract-backcompat", agentId: "a7a784072f116c4e6", model: "claude-opus-4-8[1m]", tokens: 82704 },
    ],
  };

  it("extracts status, terminal flag, summary, and per-agent info with phase", () => {
    const snapshot = parseWorkflowRunFile(RUN);
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.terminal, true);
    assert.equal(snapshot.summary, "Adversarial review");
    assert.equal(snapshot.agents.length, 2);
    assert.deepEqual(snapshot.agents[0], {
      agentId: "a1385c15bd4ffd5af",
      label: "grant_adjunct-failclosed",
      model: "claude-opus-4-8[1m]",
      tokens: 120436,
      phase: "Review",
    });
  });

  it("marks a running run as non-terminal", () => {
    const snapshot = parseWorkflowRunFile({ status: "running", workflowProgress: [] });
    assert.equal(snapshot.terminal, false);
    assert.equal(snapshot.agents.length, 0);
  });

  it("returns an empty non-terminal snapshot for malformed input", () => {
    const snapshot = parseWorkflowRunFile(undefined);
    assert.deepEqual(snapshot, { status: undefined, terminal: false, summary: undefined, agents: [] });
  });

  it("falls back to agentId as label when label is missing", () => {
    const snapshot = parseWorkflowRunFile({
      status: "failed",
      workflowProgress: [{ type: "workflow_agent", agentId: "abc" }],
    });
    assert.equal(snapshot.terminal, true);
    assert.equal(snapshot.agents[0]?.label, "abc");
    assert.equal(snapshot.agents[0]?.phase, undefined);
  });
});
