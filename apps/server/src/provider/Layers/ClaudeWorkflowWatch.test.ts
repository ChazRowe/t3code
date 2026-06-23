import { assert, describe, it } from "@effect/vitest";

import { parseWorkflowLaunch } from "./ClaudeWorkflowWatch.ts";

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
