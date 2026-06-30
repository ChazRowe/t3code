# Workflow-Tool Subagent Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code `Workflow`-tool subagents (the `agent()` calls inside a workflow script) appear in t3code's session/subagent tree, where today they are completely invisible.

**Architecture:** t3code only detects Claude subagents via the live Agent-SDK message stream (`message.parent_tool_use_id`), but `Workflow` `agent()` calls run in isolated sub-queries that never enter that stream. Claude _does_ write their transcripts and a run journal to disk. We add a **Claude-provider-isolated disk watcher**: when a `Workflow` tool_result flows through the SDK loop (it carries `Transcript dir:` + `Run ID:` in-band), a forked fiber polls the run's on-disk files and translates each workflow agent into the existing generic `collab_agent_tool_call` nested-item events the adapter already emits for `Task` subagents. Downstream (projection → sidebar tree → watch view) and all other providers are untouched.

**Tech Stack:** TypeScript, Effect (`Effect`, `Fiber`, `Queue`, `Stream`), `@effect/platform` `FileSystem`/`Path`, `@effect/vitest` for tests. New pure module + edits to one adapter file.

## Global Constraints

- **Zero shared-contract changes.** Do NOT edit `packages/contracts/src/providerRuntime.ts`. Workflow agents reuse the existing `collab_agent_tool_call` `CanonicalItemType`; phase folds into the item label, tokens/model fold into the item `data`. (A richer additive contract field is explicitly deferred to v2.)
- **Provider isolation.** All changes live in the Claude provider layer (`apps/server/src/provider/Layers/ClaudeAdapter.ts` + one new sibling module). Do NOT touch Codex/Cursor/Grok/OpenCode adapters, the projection pipeline, or the web UI.
- **Error isolation.** The watcher fiber MUST catch all its own failures (missing/partial files, JSON parse errors) and never fault the main `streamFiber`. Wrap the watcher body in `Effect.catchAllCause` + `Effect.ensuring`.
- **Effect conventions.** Match the file: `Effect.fn("name")(function* (...) {...})` for effectful helpers; emit events only via the existing `offerRuntimeEvent`; build event stamps via `makeEventStamp()`; brand item ids via `asRuntimeItemId(...)`; delays via `Effect.sleep("1 second")` (string form — already used at `apps/server/src/provider/opencodeRuntime.ts:382`; no `Duration` import needed).
- **Node 24 for tests.** The harness shell is Node v23; prepend the v24 nvm bin to PATH before running `apps/server` tests or they crash. Run tests as: `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v24' | head -1)/bin:$PATH"` then `pnpm --filter @t3tools/server test ...`. (Verify the exact filter name with `pnpm --filter ./apps/server test` if needed.)
- **All `Workflow` runs are background.** The `Workflow` tool returns its tool_result immediately (with `Transcript dir:`/`Run ID:`) and the run completes later via a separate notification. The watcher therefore ALWAYS polls until terminal — there is no "already complete at tool_result" fast path to special-case. (Confirmed: zero foreground workflow tool_results exist in the local transcript corpus; every observed run is `Workflow launched in background.`)

---

## File Structure

- **Create** `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts` — pure, dependency-free parsing + reconciliation logic for workflow run files. One responsibility: turn on-disk bytes into a normalized, deduplicated set of "this agent started / this agent completed" intentions. No Effect, no FileSystem — trivially unit-testable.
- **Create** `apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts` — unit tests for the pure module, using verbatim fixtures captured from real workflow runs.
- **Modify** `apps/server/src/provider/Layers/ClaudeAdapter.ts` — (a) classify the `Workflow` tool as `collab_agent_tool_call` so it renders as a subagent container; (b) add watcher state to `ClaudeSessionContext`; (c) add the `watchWorkflowRun` forked-fiber driver that reads files, calls the pure reconciler, and emits events; (d) trigger it from `handleUserMessage` on a `Workflow` tool_result; (e) tear watchers down in the stop path.
- **Modify** `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` — one end-to-end integration test exercising classifier → trigger → watcher → emitted nested events + parent linkage, using a real temp dir pre-populated with a completed run.

### Verified reference facts (from real runs — do not re-derive)

`Workflow` tool_result text (background launch) literally contains these lines:

```
Workflow launched in background. Task ID: w4h1ox7dc
Summary: <one-line summary>
Transcript dir: /home/.../<session-id>/subagents/workflows/wf_adfba522-74f
Script file: /tmp/wf-understand.js
Run ID: wf_adfba522-74f
...
```

On-disk layout for a run (parent session dir = `<session>`):

- `<session>/workflows/wf_<runId>.json` — run journal. Relevant keys: `status` (e.g. `"completed"`), `summary`, `workflowProgress` (ordered array). Each element is either `{type:"workflow_phase", index, title}` or `{type:"workflow_agent", index, label, agentId, model, tokens}`. Agents belong to the most recent preceding `workflow_phase` in array order.
- `<session>/subagents/workflows/wf_<runId>/journal.jsonl` — live append log. Lines: `{type:"started", key, agentId}` and `{type:"result", key, agentId, result:{...}}`. (No label/model/tokens here — those only live in the `.json` above.)
- `<session>/subagents/workflows/wf_<runId>/agent-<agentId>.jsonl` + `.meta.json` (`{"agentType":"workflow-subagent"}`) — per-agent transcript (not needed for MVP).

Path derivation: from `transcriptDir = <session>/subagents/workflows/wf_<runId>`, the run-file is `path.join(path.dirname(path.dirname(path.dirname(transcriptDir))), "workflows", `${runId}.json`)` and the journal is `path.join(transcriptDir, "journal.jsonl")`.

Tree wiring (already in place — this is WHY the design works, no changes needed):

- Subagent roots = `collab_agent_tool_call` activities with `parent_item_id IS NULL` (`ProjectionSnapshotQuery.ts:1050-1051`). So the top-level `Workflow` tool item, once classified `collab_agent_tool_call`, becomes a root subagent node.
- Children = `collab_agent_tool_call` activities whose `parentItemId` equals the root's itemId (`ws.ts:175`, `ProjectionPipeline.ts:238-245`). So each workflow agent, emitted with `parentItemId = <Workflow tool itemId>`, nests under it.

---

## Task 1: Pure parser — `parseWorkflowLaunch`

**Files:**

- Create: `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts`
- Test: `apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface WorkflowLaunch { readonly runId: string; readonly transcriptDir: string; readonly taskId: string | undefined }`
  - `function parseWorkflowLaunch(text: string): WorkflowLaunch | undefined`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @t3tools/server test ClaudeWorkflowWatch`
Expected: FAIL — `Cannot find module './ClaudeWorkflowWatch.ts'` (or `parseWorkflowLaunch is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @t3tools/server test ClaudeWorkflowWatch`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts
git commit -m "feat(provider): parse Workflow tool_result launch text"
```

---

## Task 2: Pure parser — `parseWorkflowRunFile`

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts`
- Test: `apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts`

**Interfaces:**

- Consumes: nothing (takes already-`JSON.parse`d `unknown`).
- Produces:
  - `interface WorkflowAgentInfo { readonly agentId: string; readonly label: string; readonly model: string | undefined; readonly tokens: number | undefined; readonly phase: string | undefined }`
  - `interface WorkflowRunSnapshot { readonly status: string | undefined; readonly terminal: boolean; readonly summary: string | undefined; readonly agents: ReadonlyArray<WorkflowAgentInfo> }`
  - `function parseWorkflowRunFile(raw: unknown): WorkflowRunSnapshot`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts` (and add `parseWorkflowRunFile` to the import from `./ClaudeWorkflowWatch.ts`):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @t3tools/server test ClaudeWorkflowWatch`
Expected: FAIL — `parseWorkflowRunFile is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @t3tools/server test ClaudeWorkflowWatch`
Expected: PASS (Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts
git commit -m "feat(provider): parse Workflow run journal into agent snapshot"
```

---

## Task 3: Pure parsers — `parseWorkflowJournalLines` + `mergeWorkflowAgents`

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts`
- Test: `apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts`

**Interfaces:**

- Consumes: `WorkflowRunSnapshot` (Task 2).
- Produces:
  - `type WorkflowAgentLifecycle = "started" | "completed"`
  - `interface WorkflowJournalState { readonly statuses: ReadonlyMap<string, WorkflowAgentLifecycle>; readonly resultSummaries: ReadonlyMap<string, string> }`
  - `interface MergedWorkflowAgent { readonly info: WorkflowAgentInfo; readonly status: WorkflowAgentLifecycle; readonly resultSummary: string | undefined }`
  - `function parseWorkflowJournalLines(lines: ReadonlyArray<string>): WorkflowJournalState`
  - `function mergeWorkflowAgents(snapshot: WorkflowRunSnapshot, journal: WorkflowJournalState): ReadonlyArray<MergedWorkflowAgent>`

- [ ] **Step 1: Write the failing test**

Append to the test file (extend the import to include `parseWorkflowJournalLines`, `mergeWorkflowAgents`, and type `WorkflowRunSnapshot` if you reference it):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @t3tools/server test ClaudeWorkflowWatch`
Expected: FAIL — `parseWorkflowJournalLines is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @t3tools/server test ClaudeWorkflowWatch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts
git commit -m "feat(provider): merge Workflow journal liveness with run-file agent info"
```

---

## Task 4: Pure reconciler — `reconcileWorkflowAgents` + `formatWorkflowAgentLabel`

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts`
- Test: `apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts`

**Interfaces:**

- Consumes: `MergedWorkflowAgent` (Task 3).
- Produces:
  - `interface WorkflowReconcileResult { readonly toStart: ReadonlyArray<MergedWorkflowAgent>; readonly toComplete: ReadonlyArray<MergedWorkflowAgent>; readonly emitted: ReadonlySet<string> }`
  - `function reconcileWorkflowAgents(emitted: ReadonlySet<string>, merged: ReadonlyArray<MergedWorkflowAgent>): WorkflowReconcileResult`
  - `function formatWorkflowAgentLabel(info: WorkflowAgentInfo): string`

The reconciler is the dedup heart: given the set of already-emitted keys, return only the NEW start/complete intentions and the updated key set. Keys are `start:<agentId>` and `done:<agentId>`. This is what makes polling idempotent across reconnect/resume.

- [ ] **Step 1: Write the failing test**

Append to the test file (extend the import to include `reconcileWorkflowAgents`, `formatWorkflowAgentLabel`):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @t3tools/server test ClaudeWorkflowWatch`
Expected: FAIL — `reconcileWorkflowAgents is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @t3tools/server test ClaudeWorkflowWatch`
Expected: PASS (all Task 1–4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/ClaudeWorkflowWatch.ts apps/server/src/provider/Layers/ClaudeWorkflowWatch.test.ts
git commit -m "feat(provider): reconcile Workflow agents into deduped start/complete intents"
```

---

## Task 5: Classify `Workflow` as a subagent container

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts:662-711` (`classifyToolItemType`), `apps/server/src/provider/Layers/ClaudeAdapter.ts:903-929` (`summarizeToolRequest`)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: behavior change only — `classifyToolItemType("Workflow") === "collab_agent_tool_call"`; `summarizeToolRequest("Workflow", input)` returns a readable one-liner instead of the dumped script.

`classifyToolItemType` and `summarizeToolRequest` are module-private (not exported), so test them through the public stream path: a top-level `Workflow` tool_use must emit `item.started` with `itemType: "collab_agent_tool_call"`.

- [ ] **Step 1: Write the failing test**

Add this `it.effect` inside the `describe("ClaudeAdapterLive", ...)` block in `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` (place it right after the existing Task-tool test near line 1350). It mirrors that test's structure exactly:

```ts
it.effect("classifies a top-level Workflow tool as a subagent container", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;

    const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );

    const session = yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({ threadId: session.threadId, input: "orchestrate", attachments: [] });

    harness.query.emit({
      type: "stream_event",
      session_id: "sdk-session-wf",
      uuid: "stream-wf-1",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "wf-tool-1",
          name: "Workflow",
          input: { scriptPath: "/tmp/wf-understand.js" },
        },
      },
    } as unknown as SDKMessage);

    harness.query.emit({
      type: "assistant",
      session_id: "sdk-session-wf",
      uuid: "assistant-wf-1",
      parent_tool_use_id: null,
      message: { id: "assistant-message-wf-1", content: [{ type: "text", text: "Launched" }] },
    } as unknown as SDKMessage);

    harness.query.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      errors: [],
      session_id: "sdk-session-wf",
      uuid: "result-wf-1",
    } as unknown as SDKMessage);

    const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
    const toolStarted = runtimeEvents.find(
      (event) => event.type === "item.started" && String(event.itemId) === "wf-tool-1",
    );
    assert.equal(toolStarted?.type, "item.started");
    if (toolStarted?.type === "item.started") {
      assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
      assert.equal(toolStarted.payload.detail, "Workflow: /tmp/wf-understand.js");
    }
  }).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter -t "classifies a top-level Workflow"`
Expected: FAIL — `itemType` is `"dynamic_tool_call"` (and `detail` is the serialized `{"scriptPath":...}`), not the expected collab values.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/provider/Layers/ClaudeAdapter.ts`, add a `Workflow` branch to `classifyToolItemType` immediately after the `spawn_agent`/`list_agents` block (around line 671, before the generic `if (normalized.includes("agent"))`):

```ts
// The Workflow tool orchestrates a fleet of agent() sub-queries. Classify it as
// a subagent container so it renders as a root subagent node and the workflow
// agents (emitted by ClaudeWorkflowWatch) can nest beneath it.
if (normalized === "workflow") {
  return "collab_agent_tool_call";
}
```

And add a `Workflow` special case at the very top of `summarizeToolRequest` (before the `command` check around line 904) so the node detail is readable rather than the dumped script:

```ts
if (toolName === "Workflow") {
  const scriptPath = typeof input.scriptPath === "string" ? input.scriptPath : undefined;
  return scriptPath ? `Workflow: ${scriptPath}` : "Workflow: inline script";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter -t "classifies a top-level Workflow"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
git commit -m "feat(provider): render Workflow tool as a subagent container node"
```

---

## Task 6: Watcher fiber, trigger, and teardown

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` — imports (top), `ClaudeSessionContext` (`:179-221`), context construction (`:3429` declarations + `:3878-3902` literal), new `watchWorkflowRun` helper (place adjacent to `handleSubagentMessage`, after `:2733`), trigger inside `handleUserMessage` (after `:2560` `context.inFlightTools.delete(index)`), teardown in the stop path (after `:3289`).
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

**Interfaces:**

- Consumes: `parseWorkflowLaunch`, `parseWorkflowRunFile`, `parseWorkflowJournalLines`, `mergeWorkflowAgents`, `reconcileWorkflowAgents`, `formatWorkflowAgentLabel`, `WorkflowLaunch` from `./ClaudeWorkflowWatch.ts`; existing in-scope: `fileSystem`, `path`, `offerRuntimeEvent`, `makeEventStamp`, `asRuntimeItemId`, `asCanonicalTurnId`, `nativeProviderRefs`, `PROVIDER`.
- Produces: nested `collab_agent_tool_call` `item.started`/`item.completed` runtime events, itemId `<runId>:<agentId>`, `parentItemId = <Workflow tool itemId>`.

- [ ] **Step 1: Write the failing test**

Add this `it.effect` to `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`, right after the Task 5 test. It uses a real temp dir (the harness already provides `NodeServices.layer`, and the file already imports `mkdirSync`, `writeFileSync`, `mkdtempSync`, `os`, `path`):

```ts
it.effect("surfaces Workflow agents as nested subagent items via the disk watcher", () => {
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "t3-wf-watch-"));
  const runId = "wf_test123";
  const transcriptDir = path.join(sessionRoot, "subagents", "workflows", runId);
  mkdirSync(path.join(sessionRoot, "workflows"), { recursive: true });
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    path.join(sessionRoot, "workflows", `${runId}.json`),
    JSON.stringify({
      runId,
      status: "completed",
      summary: "two-agent review",
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Review" },
        {
          type: "workflow_agent",
          index: 1,
          label: "alpha",
          agentId: "agentAAA",
          model: "claude-opus-4-8[1m]",
          tokens: 100,
        },
        {
          type: "workflow_agent",
          index: 2,
          label: "beta",
          agentId: "agentBBB",
          model: "claude-opus-4-8[1m]",
          tokens: 200,
        },
      ],
    }),
  );
  writeFileSync(
    path.join(transcriptDir, "journal.jsonl"),
    [
      `{"type":"started","agentId":"agentAAA"}`,
      `{"type":"started","agentId":"agentBBB"}`,
      `{"type":"result","agentId":"agentAAA","result":"alpha-done"}`,
      `{"type":"result","agentId":"agentBBB","result":"beta-done"}`,
    ].join("\n"),
  );

  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;

    // Collect until both workflow-agent completions have arrived (robust to ordering).
    let completedAgents = 0;
    const runtimeEventsFiber = yield* Stream.takeUntil(adapter.streamEvents, (event) => {
      if (event.type === "item.completed" && String(event.itemId).startsWith(`${runId}:`)) {
        completedAgents += 1;
      }
      return completedAgents >= 2;
    }).pipe(Stream.runCollect, Effect.forkChild);

    const session = yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({ threadId: session.threadId, input: "orchestrate", attachments: [] });

    harness.query.emit({
      type: "stream_event",
      session_id: "sdk-session-wf2",
      uuid: "stream-wf2-1",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "wf-tool-2",
          name: "Workflow",
          input: { scriptPath: "/tmp/x.js" },
        },
      },
    } as unknown as SDKMessage);

    harness.query.emit({
      type: "user",
      session_id: "sdk-session-wf2",
      uuid: "user-wf2-1",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "wf-tool-2",
            is_error: false,
            content: `Workflow launched in background. Task ID: tk1\nTranscript dir: ${transcriptDir}\nRun ID: ${runId}`,
          },
        ],
      },
    } as unknown as SDKMessage);

    const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

    const started = runtimeEvents.filter(
      (e) => e.type === "item.started" && String(e.itemId).startsWith(`${runId}:`),
    );
    const completed = runtimeEvents.filter(
      (e) => e.type === "item.completed" && String(e.itemId).startsWith(`${runId}:`),
    );
    assert.equal(started.length, 2, "both workflow agents should start");
    assert.equal(completed.length, 2, "both workflow agents should complete");

    const alpha = completed.find((e) => String(e.itemId) === `${runId}:agentAAA`);
    assert.ok(alpha, "alpha completion present");
    if (alpha?.type === "item.completed") {
      assert.equal(alpha.payload.itemType, "collab_agent_tool_call");
      assert.equal(alpha.payload.status, "completed");
      assert.equal(alpha.payload.parentItemId, "wf-tool-2");
      assert.equal(alpha.payload.detail, "Review: alpha");
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => rmSync(sessionRoot, { recursive: true, force: true }))),
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter -t "surfaces Workflow agents"`
Expected: FAIL — no `<runId>:*` events are ever emitted, so `Stream.takeUntil` never completes and the test times out (or `started.length` assertion fails if it does complete). This is the expected red state before wiring.

- [ ] **Step 3a: Add the import**

At the top of `apps/server/src/provider/Layers/ClaudeAdapter.ts`, add (next to other local `./` imports):

```ts
import {
  formatWorkflowAgentLabel,
  mergeWorkflowAgents,
  parseWorkflowJournalLines,
  parseWorkflowLaunch,
  parseWorkflowRunFile,
  reconcileWorkflowAgents,
  type WorkflowLaunch,
} from "./ClaudeWorkflowWatch.ts";
```

- [ ] **Step 3b: Add watcher state to `ClaudeSessionContext`**

In the `ClaudeSessionContext` interface (`:179`), add after `subagentNestedToolCalls` (`:213`):

```ts
  // Run IDs of Workflow runs we've already started a disk-watcher fiber for —
  // guards against re-triggering on a reprocessed tool_result.
  readonly workflowWatchedRunIds: Set<string>;
  // Live workflow watcher fibers keyed by runId, interrupted on session stop.
  readonly workflowWatchers: Map<string, Fiber.Fiber<void, never>>;
```

- [ ] **Step 3c: Initialize the new state**

In `startSession`, near the other `const ... = new Map(...)` declarations (~`:3429`, alongside `inFlightTools`), add:

```ts
const workflowWatchedRunIds = new Set<string>();
const workflowWatchers = new Map<string, Fiber.Fiber<void, never>>();
```

Then add both to the `context: ClaudeSessionContext = {...}` literal (`:3878`), after `subagentNestedToolCalls,`:

```ts
        workflowWatchedRunIds,
        workflowWatchers,
```

- [ ] **Step 3d: Add the `watchWorkflowRun` helper**

Insert immediately after `handleSubagentMessage` ends (`:2733`), so it shares scope with `fileSystem`, `path`, `offerRuntimeEvent`, `makeEventStamp`, etc.:

```ts
const WORKFLOW_MAX_POLLS = 1800; // ~30 min at 1 poll/sec — backstop against a leaked fiber.

// Builds the shared item payload for a workflow agent's nested collab item. The
// `data` mirrors a Task subagent (toolName/input/result) so existing watch-view
// rendering works unchanged; phase/model/tokens ride along for v2 badge work.
const workflowAgentItemData = (
  runId: string,
  agent: {
    info: {
      agentId: string;
      label: string;
      model: string | undefined;
      tokens: number | undefined;
      phase: string | undefined;
    };
    resultSummary: string | undefined;
  },
  includeResult: boolean,
): Record<string, unknown> => ({
  toolName: "Workflow",
  input: {
    subagent_type: agent.info.phase ?? "workflow",
    description: agent.info.label,
    ...(agent.info.model ? { model: agent.info.model } : {}),
  },
  ...(includeResult ? { result: { content: agent.resultSummary ?? "" } } : {}),
  workflowRunId: runId,
  workflowAgentId: agent.info.agentId,
  ...(agent.info.tokens !== undefined ? { tokens: agent.info.tokens } : {}),
});

// Polls a Workflow run's on-disk files and translates each agent into nested
// collab_agent_tool_call lifecycle events parented to the Workflow tool item.
// Stops when the run reaches a terminal status or the poll backstop is hit.
const watchWorkflowRun = Effect.fn("watchWorkflowRun")(function* (
  context: ClaudeSessionContext,
  parentToolUseId: string,
  launch: WorkflowLaunch,
) {
  const sessionDir = path.dirname(path.dirname(path.dirname(launch.transcriptDir)));
  const runFilePath = path.join(sessionDir, "workflows", `${launch.runId}.json`);
  const journalPath = path.join(launch.transcriptDir, "journal.jsonl");
  const parentItemId = asRuntimeItemId(parentToolUseId);

  const readRunFile = fileSystem.readFileString(runFilePath).pipe(
    Effect.map((text): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    }),
    Effect.catchAll(() => Effect.succeed(undefined as unknown)),
  );
  const readJournalLines = fileSystem.readFileString(journalPath).pipe(
    Effect.map((text) => text.split("\n")),
    Effect.catchAll(() => Effect.succeed([] as Array<string>)),
  );

  let emitted = new Set<string>();

  const pollOnce = Effect.fn("watchWorkflowRun.poll")(function* () {
    const snapshot = parseWorkflowRunFile(yield* readRunFile);
    const journal = parseWorkflowJournalLines(yield* readJournalLines);
    let merged = mergeWorkflowAgents(snapshot, journal);
    // On a terminal run, force every known agent to "completed" so no nested
    // item is left pulsing forever if its journal result line never landed.
    if (snapshot.terminal) {
      merged = merged.map((m) => ({ ...m, status: "completed" as const }));
    }
    const result = reconcileWorkflowAgents(emitted, merged);
    emitted = new Set(result.emitted);

    const turnIdPart = context.turnState
      ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
      : {};

    for (const agent of result.toStart) {
      const stamp = yield* makeEventStamp();
      const itemId = `${launch.runId}:${agent.info.agentId}`;
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...turnIdPart,
        itemId: asRuntimeItemId(itemId),
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          detail: formatWorkflowAgentLabel(agent.info),
          data: workflowAgentItemData(launch.runId, agent, false),
          parentItemId,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: itemId }),
        raw: {
          source: "claude.workflow.watch",
          method: "workflow/agent/started",
          payload: { runId: launch.runId, agentId: agent.info.agentId },
        },
      });
    }

    for (const agent of result.toComplete) {
      const stamp = yield* makeEventStamp();
      const itemId = `${launch.runId}:${agent.info.agentId}`;
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...turnIdPart,
        itemId: asRuntimeItemId(itemId),
        payload: {
          itemType: "collab_agent_tool_call",
          status: "completed",
          title: "Subagent task",
          detail: formatWorkflowAgentLabel(agent.info),
          data: workflowAgentItemData(launch.runId, agent, true),
          parentItemId,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: itemId }),
        raw: {
          source: "claude.workflow.watch",
          method: "workflow/agent/completed",
          payload: { runId: launch.runId, agentId: agent.info.agentId },
        },
      });
    }

    return snapshot.terminal;
  });

  const loop = (n: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (n >= WORKFLOW_MAX_POLLS) {
        return;
      }
      const terminal = yield* pollOnce();
      if (terminal) {
        return;
      }
      yield* Effect.sleep("1 second");
      yield* loop(n + 1);
    });

  yield* loop(0);
});
```

- [ ] **Step 3e: Trigger the watcher from `handleUserMessage`**

In `handleUserMessage`, immediately after `context.inFlightTools.delete(index);` (`:2560`), add:

```ts
if (tool.toolName === "Workflow" && !toolResult.isError) {
  const launch = parseWorkflowLaunch(toolResult.text);
  if (launch && !context.workflowWatchedRunIds.has(launch.runId)) {
    context.workflowWatchedRunIds.add(launch.runId);
    const parentToolUseId = tool.itemId;
    const watcher =
      yield *
      Effect.forkDaemon(
        watchWorkflowRun(context, parentToolUseId, launch).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError("Claude workflow watcher failed.", {
              cause,
              runId: launch.runId,
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              context.workflowWatchers.delete(launch.runId);
            }),
          ),
        ),
      );
    context.workflowWatchers.set(launch.runId, watcher);
  }
}
```

- [ ] **Step 3f: Tear watchers down on stop**

In the stop path, immediately after the `streamFiber` interrupt block (`:3289`), add:

```ts
for (const watcher of context.workflowWatchers.values()) {
  if (watcher.pollUnsafe() === undefined) {
    yield * Fiber.interrupt(watcher);
  }
}
context.workflowWatchers.clear();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter -t "surfaces Workflow agents"`
Expected: PASS — 2 nested `item.started` + 2 `item.completed`, each `collab_agent_tool_call`, `parentItemId === "wf-tool-2"`, alpha detail `"Review: alpha"`.

- [ ] **Step 5: Run the full adapter + watcher suites**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter ClaudeWorkflowWatch`
Expected: PASS — no regressions in the existing ClaudeAdapter tests (the `Workflow`→collab classification change only affects `Workflow`).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
git commit -m "feat(provider): watch Workflow runs on disk and surface their agents in the subagent tree"
```

---

## Task 7: Typecheck, lint, and full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the server package**

Run: `pnpm --filter @t3tools/server typecheck` (or the repo's check task, e.g. `pnpm check` / `pnpm -w typecheck` — confirm the script name in `package.json`).
Expected: no type errors. Common fixes if any: ensure `Fiber` is imported (it already is at `ClaudeAdapter.ts:28`-ish), and that the new context fields appear in BOTH the interface and the literal.

- [ ] **Step 2: Lint**

Run: `pnpm --filter @t3tools/server lint` (confirm script name).
Expected: clean. The `@effect-diagnostics` node-builtin rule does not apply (the new module uses no node builtins; the adapter already uses `fileSystem`/`path` services).

- [ ] **Step 3: Run the full provider test suite**

Run: `pnpm --filter @t3tools/server test provider`
Expected: PASS. Confirms no cross-adapter regression from the shared `classifyToolItemType`/`summarizeToolRequest` edits.

- [ ] **Step 4: Manual end-to-end verification (REQUIRED SUB-SKILL: superpowers:verification-before-completion)**

Deploy to the running daemon and drive a real workflow:

- `pnpm daemon:deploy` (see memory `t3code-daemon-deployment`).
- In a Claude session inside t3code, run a small `Workflow` (e.g. 2 trivial agents).
- Confirm in the sidebar subagent tree: a `Workflow` root node appears with each agent nested beneath it, transitioning from running → completed, labeled `"<phase>: <agent label>"`.
- Tail the daemon log for `Claude workflow watcher failed.` — there should be none.

- [ ] **Step 5: Final commit (if Step 4 surfaced fixes)**

```bash
git add -A
git commit -m "fix(provider): address workflow watcher verification findings"
```

---

## Known limitations (documented, acceptable for MVP — do NOT try to fix in this plan)

- **Parent node completes early.** The `Workflow` tool_result returns immediately (background launch), so the root `Workflow` node shows `completed` while its agents are still running. Children still appear and update live beneath it. Keeping the parent `inProgress` until the run terminates is a v2 refinement (it requires deferring the parent tool item's completion, which fights the SDK's immediate result).
- **Label-only metadata.** Phase is folded into the label (`"<phase>: <label>"`) and tokens/model ride in item `data` but are not rendered as dedicated badges — that needs an additive contract field (v2; see design memory caveat).
- **Polling, not byte-offset tailing.** 1 s polling with idempotent reconciliation (no duplicate events) — simpler and race-free vs. partial-line `fs.watch` tailing. Latency ≤1 s is fine for a watch view.
- **Per-agent transcript not surfaced.** The agent `.jsonl` transcripts under `subagents/workflows/wf_<runId>/` are not opened; only lifecycle + result summary are shown. Full transcript drill-in is future work.

## Self-Review (completed by plan author)

- **Spec coverage:** root cause (stream-only blindness) addressed by the disk watcher (Tasks 1–6); zero-contract-change constraint honored (reuses `collab_agent_tool_call`, Task 5); parent linkage via in-band `Transcript dir`/`Run ID` (Task 1 + 6e); error isolation (Task 6e `catchAllCause`/`ensuring`); teardown (Task 6f); liveness via journal + enrichment via run file (Tasks 2–3); dedup across polls (Task 4).
- **Placeholder scan:** none — every step carries real code and exact commands.
- **Type consistency:** `WorkflowLaunch`, `WorkflowAgentInfo`, `WorkflowRunSnapshot`, `WorkflowJournalState`, `MergedWorkflowAgent`, `WorkflowReconcileResult`, `WorkflowAgentLifecycle` are defined once (Tasks 1–4) and consumed with matching names/fields in Task 6. Event shapes (`itemType: "collab_agent_tool_call"`, `parentItemId`, `data.toolName/input/result`) mirror the verified `handleSubagentMessage` emissions at `ClaudeAdapter.ts:2699-2729`.
- **Open assumption to confirm during impl:** the exact pnpm script names (`typecheck`/`lint`/`test` filter) — verify against root `package.json` and the `@t3tools/server` package before relying on the commands above.
