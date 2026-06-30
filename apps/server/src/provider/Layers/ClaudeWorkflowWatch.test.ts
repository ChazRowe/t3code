import { assert, describe, it } from "@effect/vitest";

import {
  parseWorkflowLaunch,
  parseWorkflowRunFile,
  parseWorkflowJournalLines,
  mergeWorkflowAgents,
  reconcileWorkflowAgents,
  formatWorkflowAgentLabel,
} from "./ClaudeWorkflowWatch.ts";

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
      {
        type: "workflow_agent",
        index: 1,
        label: "grant_adjunct-failclosed",
        agentId: "a1385c15bd4ffd5af",
        model: "claude-opus-4-8[1m]",
        tokens: 120436,
      },
      {
        type: "workflow_agent",
        index: 2,
        label: "contract-backcompat",
        agentId: "a7a784072f116c4e6",
        model: "claude-opus-4-8[1m]",
        tokens: 82704,
      },
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
    assert.deepEqual(snapshot, {
      status: undefined,
      terminal: false,
      summary: undefined,
      agents: [],
    });
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

describe("parseWorkflowJournalLines", () => {
  const LINES = [
    `{"type":"started","key":"v2:k1","agentId":"a1385c15bd4ffd5af"}`,
    `{"type":"started","key":"v2:k2","agentId":"a7a784072f116c4e6"}`,
    `{"type":"result","key":"v2:k2","agentId":"a7a784072f116c4e6","result":{"findings":[{"severity":"low"}]}}`,
    ``,
    `{ this is not json `,
  ];

  it("derives latest lifecycle per agentId and a short result summary", () => {
    const state = parseWorkflowJournalLines(LINES);
    assert.equal(state.statuses.get("a1385c15bd4ffd5af"), "started");
    assert.equal(state.statuses.get("a7a784072f116c4e6"), "completed");
    assert.ok((state.resultSummaries.get("a7a784072f116c4e6") ?? "").includes("findings"));
  });

  it("tolerates an empty array", () => {
    const state = parseWorkflowJournalLines([]);
    assert.equal(state.statuses.size, 0);
  });

  it("result wins even when a started line appears after it", () => {
    const state = parseWorkflowJournalLines([
      `{"type":"result","agentId":"x","result":"done"}`,
      `{"type":"started","agentId":"x"}`,
    ]);
    assert.equal(state.statuses.get("x"), "completed");
  });
});

describe("mergeWorkflowAgents", () => {
  it("uses snapshot labels and journal lifecycle, defaulting unseen agents to started", () => {
    const snapshot = parseWorkflowRunFile({
      status: "running",
      workflowProgress: [
        { type: "workflow_phase", title: "Review" },
        { type: "workflow_agent", agentId: "a1", label: "alpha", tokens: 10 },
        { type: "workflow_agent", agentId: "a2", label: "beta" },
      ],
    });
    const journal = parseWorkflowJournalLines([
      `{"type":"started","agentId":"a1"}`,
      `{"type":"result","agentId":"a1","result":"done-a1"}`,
    ]);
    const merged = mergeWorkflowAgents(snapshot, journal);
    const a1 = merged.find((m) => m.info.agentId === "a1");
    const a2 = merged.find((m) => m.info.agentId === "a2");
    assert.equal(a1?.status, "completed");
    assert.equal(a1?.info.label, "alpha");
    assert.equal(a1?.resultSummary, "done-a1");
    assert.equal(a2?.status, "started");
    assert.equal(a2?.info.label, "beta");
  });

  it("includes journal-only agents not yet in the run file", () => {
    const snapshot = parseWorkflowRunFile({ status: "running", workflowProgress: [] });
    const journal = parseWorkflowJournalLines([`{"type":"started","agentId":"ghost"}`]);
    const merged = mergeWorkflowAgents(snapshot, journal);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.info.agentId, "ghost");
    assert.equal(merged[0]?.info.label, "ghost");
  });
});

describe("reconcileWorkflowAgents", () => {
  const agent = (agentId: string, status: "started" | "completed") => ({
    info: { agentId, label: agentId, model: undefined, tokens: undefined, phase: undefined },
    status,
    resultSummary: undefined,
  });

  it("emits a start for a newly-seen started agent, no complete yet", () => {
    const r = reconcileWorkflowAgents(new Set(), [agent("a1", "started")]);
    assert.deepEqual(
      r.toStart.map((a) => a.info.agentId),
      ["a1"],
    );
    assert.equal(r.toComplete.length, 0);
    assert.ok(r.emitted.has("start:a1"));
    assert.ok(!r.emitted.has("done:a1"));
  });

  it("emits start+complete together for an already-completed agent", () => {
    const r = reconcileWorkflowAgents(new Set(), [agent("a1", "completed")]);
    assert.deepEqual(
      r.toStart.map((a) => a.info.agentId),
      ["a1"],
    );
    assert.deepEqual(
      r.toComplete.map((a) => a.info.agentId),
      ["a1"],
    );
  });

  it("does not re-emit already-emitted keys across polls", () => {
    const first = reconcileWorkflowAgents(new Set(), [agent("a1", "started")]);
    const second = reconcileWorkflowAgents(first.emitted, [agent("a1", "completed")]);
    assert.equal(second.toStart.length, 0); // start already emitted
    assert.deepEqual(
      second.toComplete.map((a) => a.info.agentId),
      ["a1"],
    );
    const third = reconcileWorkflowAgents(second.emitted, [agent("a1", "completed")]);
    assert.equal(third.toStart.length, 0);
    assert.equal(third.toComplete.length, 0); // fully settled — nothing new
  });
});

describe("formatWorkflowAgentLabel", () => {
  it("prefixes the phase as a 'type: description' label when present", () => {
    assert.equal(
      formatWorkflowAgentLabel({
        agentId: "a1",
        label: "alpha",
        model: undefined,
        tokens: undefined,
        phase: "Review",
      }),
      "Review: alpha",
    );
  });
  it("uses the bare label when no phase", () => {
    assert.equal(
      formatWorkflowAgentLabel({
        agentId: "a1",
        label: "alpha",
        model: undefined,
        tokens: undefined,
        phase: undefined,
      }),
      "alpha",
    );
  });
});
