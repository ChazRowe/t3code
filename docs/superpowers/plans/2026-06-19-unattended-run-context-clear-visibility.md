# Unattended-run context-clear visibility + earlier wrap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit persistent inline markers when an unattended run clears context between iterations (showing before/after context size), and nudge the agent to wrap earlier via a preamble budget.

**Architecture:** All server logic lives in the existing `UnattendedRunReactor` (which already consumes `thread.activity-appended` domain events) plus pure formatting helpers in `unattendedRun.ts`. The reactor tracks the latest `context-window.updated` activity per thread, emits an `unattended.context-cleared` marker activity at each mid-run clear, and emits a one-shot `unattended.context-fresh` marker when the fresh session first reports usage. Marker activities render inline automatically through the existing `deriveWorkLogEntries` path — no web rendering change is required for visibility. The earlier-wrap behavior is a pure text addition to the run preamble.

**Tech Stack:** TypeScript, Effect (effect@4 beta), `@t3tools/contracts` schemas, `vite-plus`/`@effect/vitest` for tests.

## Global Constraints

- **Do NOT touch** `apps/server/src/provider/Layers/ClaudeAdapter.*`, `package.json`, `pnpm-lock.yaml`, `ops/`, or the `docs/superpowers/.../daemon-build-deploy*` files — all uncommitted user WIP.
- **No contracts schema change.** Activity `kind` is a free-form `TrimmedNonEmptyString`; activity `payload` is `Schema.Unknown`. New marker kinds need no schema edits.
- **Marker kind literals (exact):** `unattended.context-cleared` and `unattended.context-fresh`.
- **Markers are best-effort:** a failure to append a marker must never fault or stall the run — swallow non-interrupt failures and log.
- **Wrap budget:** ~35% of the context window, phrased as a percentage (model-agnostic).
- **Commits/branch:** Before starting, the working tree already contains an uncommitted `awaiting-input` fix in `UnattendedRunReactor.ts` + `.test.ts`, `decider.ts`, `unattendedRunBanner.*`, and `contracts/orchestration.ts`. Create a branch off `main` first (`git switch -c chaz/unattended-context-markers`). The user pushes manually (no PR). Every commit uses explicit scoped `git add <paths>` — never `git add -A` — to avoid sweeping unrelated WIP.

---

### Task 1: Preamble wrap budget

**Files:**

- Modify: `apps/server/src/orchestration/unattendedRun.ts` (`buildUnattendedPreamble`)
- Test: `apps/server/src/orchestration/unattendedRun.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: no new exports; `buildUnattendedPreamble(totalIterations)` output now contains the wrap-budget paragraph.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("unattended run constants", ...)` block in `apps/server/src/orchestration/unattendedRun.test.ts`:

```ts
it("preamble states a ~35% wrap-budget ceiling", () => {
  const preamble = buildUnattendedPreamble(5);
  expect(preamble).toContain("35%");
  expect(preamble.toLowerCase()).toContain("ceiling");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && pnpm exec vp test run src/orchestration/unattendedRun.test.ts -t "wrap-budget"`
Expected: FAIL — `expected '…' to contain '35%'`.

- [ ] **Step 3: Add the budget paragraph**

In `apps/server/src/orchestration/unattendedRun.ts`, modify `buildUnattendedPreamble`. Insert the new paragraph immediately before the `If you instead need a human decision` block:

```ts
export const buildUnattendedPreamble = (totalIterations: number): string =>
  [
    `This is an UNATTENDED run of ${totalIterations} iteration(s). No human will`,
    `respond between iterations.`,
    ``,
    `Do as much as you can this context window. When you reach a good stopping`,
    `point, or your context is filling, invoke your wrap skill to write the`,
    `handoff document, then end your message with the line:`,
    ``,
    WRAP_SENTINEL,
    ``,
    `on its own line. Seeing that line, I will clear the context and send you a`,
    `"continue" so you can resume from the handoff.`,
    ``,
    `Treat about 35% of your context window as your wrap ceiling. When you cross`,
    `it, finish your current step, invoke your wrap skill, and emit the sentinel —`,
    `don't keep going to a "natural" stopping point. Wrapping early and often is`,
    `correct here.`,
    ``,
    `If you instead need a human decision, STOP and ask your question WITHOUT the`,
    `sentinel line — the run will pause for me.`,
  ].join("\n");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && pnpm exec vp test run src/orchestration/unattendedRun.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestration/unattendedRun.ts apps/server/src/orchestration/unattendedRun.test.ts
git commit -m "feat(orchestration): give unattended runs a ~35% wrap-budget ceiling"
```

---

### Task 2: Marker kind constants + summary formatters

**Files:**

- Modify: `apps/server/src/orchestration/unattendedRun.ts`
- Test: `apps/server/src/orchestration/unattendedRun.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces (exact exports the reactor will import in Tasks 3–4):
  - `CONTEXT_CLEARED_ACTIVITY_KIND = "unattended.context-cleared"` (string const)
  - `CONTEXT_FRESH_ACTIVITY_KIND = "unattended.context-fresh"` (string const)
  - `buildContextClearedSummary(input: { fromIteration: number; toIteration: number; usedTokens?: number; maxTokens?: number }): string`
  - `buildContextFreshSummary(input: { iteration: number; usedTokens?: number; maxTokens?: number }): string`

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `apps/server/src/orchestration/unattendedRun.test.ts`, and add the new names to the existing import from `./unattendedRun.ts`:

```ts
// add to the existing import block at the top of the file:
//   buildContextClearedSummary,
//   buildContextFreshSummary,
//   CONTEXT_CLEARED_ACTIVITY_KIND,
//   CONTEXT_FRESH_ACTIVITY_KIND,

describe("context-clear marker formatting", () => {
  it("exposes the two marker kinds", () => {
    expect(CONTEXT_CLEARED_ACTIVITY_KIND).toBe("unattended.context-cleared");
    expect(CONTEXT_FRESH_ACTIVITY_KIND).toBe("unattended.context-fresh");
  });

  it("formats a cleared marker with before-usage and percentage", () => {
    expect(
      buildContextClearedSummary({
        fromIteration: 4,
        toIteration: 5,
        usedTokens: 517_000,
        maxTokens: 1_000_000,
      }),
    ).toBe("Context cleared · iteration 4 → 5 · before 517k / 1M (52%)");
  });

  it("formats a fresh marker with the new usage and a sub-1% percentage", () => {
    expect(
      buildContextFreshSummary({ iteration: 5, usedTokens: 4_000, maxTokens: 1_000_000 }),
    ).toBe("Fresh context · iteration 5 · now 4k / 1M (0.4%)");
  });

  it("handles unknown usage on the cleared marker", () => {
    expect(buildContextClearedSummary({ fromIteration: 1, toIteration: 2 })).toBe(
      "Context cleared · iteration 1 → 2 · before usage unknown",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && pnpm exec vp test run src/orchestration/unattendedRun.test.ts -t "marker formatting"`
Expected: FAIL — import/compile error (`CONTEXT_CLEARED_ACTIVITY_KIND` not exported).

- [ ] **Step 3: Implement the constants and formatters**

Append to `apps/server/src/orchestration/unattendedRun.ts`:

```ts
/** Activity kind for the marker emitted when an iteration's context is cleared. */
export const CONTEXT_CLEARED_ACTIVITY_KIND = "unattended.context-cleared";
/** Activity kind for the marker emitted when the fresh session first reports usage. */
export const CONTEXT_FRESH_ACTIVITY_KIND = "unattended.context-fresh";

/** Compact token count: 1_000_000 -> "1M", 517_000 -> "517k", 4_000 -> "4k". */
const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1))}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000)}k`
      : `${tokens}`;

/** Percentage of the window used; one decimal under 1%, whole numbers otherwise. */
const formatPercent = (usedTokens: number, maxTokens: number): string => {
  if (maxTokens <= 0) return "—";
  const pct = (usedTokens / maxTokens) * 100;
  return pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
};

const formatUsage = (
  prefix: string,
  usage: { usedTokens?: number; maxTokens?: number },
  unknownLabel: string,
): string =>
  usage.usedTokens !== undefined && usage.maxTokens !== undefined
    ? `${prefix} ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} (${formatPercent(usage.usedTokens, usage.maxTokens)})`
    : unknownLabel;

/** Human summary for the context-cleared marker. */
export const buildContextClearedSummary = (input: {
  fromIteration: number;
  toIteration: number;
  usedTokens?: number;
  maxTokens?: number;
}): string =>
  `Context cleared · iteration ${input.fromIteration} → ${input.toIteration} · ${formatUsage(
    "before",
    input,
    "before usage unknown",
  )}`;

/** Human summary for the fresh-context marker. */
export const buildContextFreshSummary = (input: {
  iteration: number;
  usedTokens?: number;
  maxTokens?: number;
}): string =>
  `Fresh context · iteration ${input.iteration} · ${formatUsage("now", input, "fresh session")}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && pnpm exec vp test run src/orchestration/unattendedRun.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestration/unattendedRun.ts apps/server/src/orchestration/unattendedRun.test.ts
git commit -m "feat(orchestration): add context-clear marker kinds and summary formatters"
```

---

### Task 3: Reactor tracks usage and emits the before-marker on clear

**Files:**

- Modify: `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`
- Test: `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`

**Interfaces:**

- Consumes: `CONTEXT_CLEARED_ACTIVITY_KIND`, `buildContextClearedSummary` from `../unattendedRun.ts`; `EventId` from `@t3tools/contracts`.
- Produces (used by Task 4, same file): the module-private `latestContextUsage` map, `awaitingFreshContextReading` map, `readContextWindowUsage(payload)` helper, and `appendMarker(threadId, kind, summary, payload)` effect.

- [ ] **Step 1: Add a harness helper to the test file**

In `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`, add `EventId` to the `@t3tools/contracts` import if not already present (Task from the awaiting-input fix already added it — confirm it's there). Then add this helper inside `setupHarness`, next to `emitUserInputRequested`, and include it in the returned object:

```ts
// Emit a `context-window.updated` activity the way the provider does as token
// usage is reported during a turn.
const emitContextWindowUpdated = (label: string, usedTokens: number, maxTokens: number) =>
  Effect.gen(function* () {
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`cmd-ctx-${label}`),
      threadId,
      activity: {
        id: EventId.make(`ctx-${label}`),
        tone: "info",
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens, maxTokens },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
    yield* reactor.drain;
  });
```

Add `emitContextWindowUpdated` to the `return { ... }` object at the end of `setupHarness`.

- [ ] **Step 2: Write the failing test**

Add after the existing "pauses with awaiting-input…" test:

```ts
effectIt.effect("emits a context-cleared marker with the last usage when an iteration clears", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(3);

    yield* harness.emitContextWindowUpdated("iter1", 517_000, 1_000_000);
    yield* harness.driveTurnEnd("iter1", `wrap one\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    const cleared = thread?.activities.filter((a) => a.kind === "unattended.context-cleared") ?? [];
    assert.strictEqual(cleared.length, 1);
    assert.ok(cleared[0]?.summary.includes("iteration 1 → 2"), cleared[0]?.summary);
    assert.ok(cleared[0]?.summary.includes("517k"), cleared[0]?.summary);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/server && pnpm exec vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts -t "context-cleared marker"`
Expected: FAIL — `cleared.length` is `0` (reactor doesn't emit the marker yet).

- [ ] **Step 4: Implement tracking + before-marker in the reactor**

In `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`:

(a) Add `EventId` to the `@t3tools/contracts` import, and `CONTEXT_CLEARED_ACTIVITY_KIND` + `buildContextClearedSummary` to the `../unattendedRun.ts` import.

(b) Next to the existing `latestAssistantText` / `sawRunningSinceTurnStart` maps, add:

```ts
// Per-thread latest reported context-window usage (from `context-window.updated`
// activities), used to label the context-clear markers.
const latestContextUsage = new Map<string, { usedTokens: number; maxTokens: number }>();
// Per-thread flag: a clear just happened and we still owe a "fresh" marker for
// the next context-window reading.
const awaitingFreshContextReading = new Map<string, boolean>();
```

(c) Add a fresh `EventId` generator next to `freshMessageId`:

```ts
const freshEventId = crypto.randomUUIDv4.pipe(Effect.map((uuid) => EventId.make(uuid)));
```

(d) Add the usage reader and the best-effort marker append helper (place them above `clearAndContinue`):

```ts
const readContextWindowUsage = (
  payload: unknown,
): { usedTokens: number; maxTokens: number } | undefined => {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const usedTokens = record.usedTokens;
  const maxTokens = record.maxTokens;
  if (typeof usedTokens === "number" && typeof maxTokens === "number" && maxTokens > 0) {
    return { usedTokens, maxTokens };
  }
  return undefined;
};

// Append a marker activity. Best-effort: a failure here must never fault or
// stall the run, so non-interrupt causes are logged and swallowed.
const appendMarker = (
  threadId: OrchestrationThread["id"],
  kind: string,
  summary: string,
  payload: unknown,
) =>
  Effect.gen(function* () {
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("unattended-marker"),
      threadId,
      activity: {
        id: yield* freshEventId,
        tone: "info",
        kind,
        summary,
        payload,
        turnId: null,
        createdAt: yield* nowIso,
      },
      createdAt: yield* nowIso,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("unattended marker append failed", { cause: Cause.pretty(cause) }),
    ),
  );
```

(e) In `clearAndContinue`, between the `if (!settled) { ... }` block and the `thread.unattended-run.advance` dispatch, insert the before-marker emission and arm the fresh flag:

```ts
const clearedFrom = thread.unattendedRun?.currentIteration ?? 0;
const clearedUsage = latestContextUsage.get(thread.id);
yield *
  appendMarker(
    thread.id,
    CONTEXT_CLEARED_ACTIVITY_KIND,
    buildContextClearedSummary({
      fromIteration: clearedFrom,
      toIteration: clearedFrom + 1,
      ...(clearedUsage ?? {}),
    }),
    {
      fromIteration: clearedFrom,
      toIteration: clearedFrom + 1,
      ...(clearedUsage ?? {}),
    },
  );
awaitingFreshContextReading.set(thread.id, true);
```

(f) Extend the existing `case "thread.activity-appended":` in `processEvent` so it records usage (the user-input.requested handling stays unchanged below it):

```ts
        case "thread.activity-appended": {
          const activity = event.payload.activity;
          const threadId = event.payload.threadId;

          if (activity.kind === "context-window.updated") {
            const usage = readContextWindowUsage(activity.payload);
            if (usage) {
              latestContextUsage.set(threadId, usage);
            }
            return;
          }

          // The agent asked the human a question via an interactive tool
          // (AskUserQuestion). That SUSPENDS the turn waiting for an answer —
          // no turn-end (idle/ready) fires — so the no-sentinel pause path
          // never triggers and the run would hang. Pause it here for the human;
          // leave the session/turn suspended so they can answer in place, then
          // resume the run when ready.
          if (activity.kind !== "user-input.requested") {
            return;
          }
          const thread = yield* readThread(threadId);
          if (thread?.unattendedRun?.status !== "running") {
            return;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.unattended-run.pause",
            commandId: yield* serverCommandId("unattended-await-input"),
            threadId: thread.id,
            reason: "awaiting-input",
            createdAt: yield* nowIso,
          });
          return;
        }
```

> Note: the `context-window.updated` branch here only records usage. The "fresh" marker emission is added in Task 4 — leave room but do not emit it yet.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/server && pnpm exec vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts`
Expected: PASS (all tests, including the prior awaiting-input and clear/continue tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/orchestration/Layers/UnattendedRunReactor.ts apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts
git commit -m "feat(orchestration): emit an inline context-cleared marker at each unattended clear"
```

---

### Task 4: Reactor emits the one-shot fresh-context marker

**Files:**

- Modify: `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`
- Test: `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`

**Interfaces:**

- Consumes: Task 2's `CONTEXT_FRESH_ACTIVITY_KIND`, `buildContextFreshSummary`; Task 3's `latestContextUsage`, `awaitingFreshContextReading`, `readContextWindowUsage`, `appendMarker`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add after the Task 3 test:

```ts
effectIt.effect("emits exactly one fresh-context marker on the first usage after a clear", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(3);

    yield* harness.emitContextWindowUpdated("iter1", 517_000, 1_000_000);
    yield* harness.driveTurnEnd("iter1", `wrap one\n${WRAP_SENTINEL}`);

    // The fresh session (iteration 2) reports its first, small usage.
    yield* harness.emitContextWindowUpdated("fresh", 4_000, 1_000_000);

    let thread = yield* harness.readThread;
    let fresh = thread?.activities.filter((a) => a.kind === "unattended.context-fresh") ?? [];
    assert.strictEqual(fresh.length, 1);
    assert.ok(fresh[0]?.summary.includes("iteration 2"), fresh[0]?.summary);
    assert.ok(fresh[0]?.summary.includes("4k"), fresh[0]?.summary);

    // A second usage update within the same iteration must NOT add another marker.
    yield* harness.emitContextWindowUpdated("fresh2", 9_000, 1_000_000);
    thread = yield* harness.readThread;
    fresh = thread?.activities.filter((a) => a.kind === "unattended.context-fresh") ?? [];
    assert.strictEqual(fresh.length, 1);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && pnpm exec vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts -t "fresh-context marker"`
Expected: FAIL — `fresh.length` is `0`.

- [ ] **Step 3: Emit the fresh marker in the context-window branch**

In `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`, add `CONTEXT_FRESH_ACTIVITY_KIND` and `buildContextFreshSummary` to the `../unattendedRun.ts` import. Then replace the `context-window.updated` branch body added in Task 3 with:

```ts
if (activity.kind === "context-window.updated") {
  const usage = readContextWindowUsage(activity.payload);
  if (!usage) {
    return;
  }
  latestContextUsage.set(threadId, usage);
  if (!awaitingFreshContextReading.get(threadId)) {
    return;
  }
  const thread = yield * readThread(threadId);
  if (thread?.unattendedRun?.status !== "running") {
    return;
  }
  awaitingFreshContextReading.set(threadId, false);
  yield *
    appendMarker(
      thread.id,
      CONTEXT_FRESH_ACTIVITY_KIND,
      buildContextFreshSummary({
        iteration: thread.unattendedRun.currentIteration,
        usedTokens: usage.usedTokens,
        maxTokens: usage.maxTokens,
      }),
      {
        iteration: thread.unattendedRun.currentIteration,
        usedTokens: usage.usedTokens,
        maxTokens: usage.maxTokens,
      },
    );
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && pnpm exec vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestration/Layers/UnattendedRunReactor.ts apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts
git commit -m "feat(orchestration): emit a one-shot fresh-context marker after each clear"
```

---

### Task 5: Web regression test — markers render inline

**Files:**

- Test: `apps/web/src/session-logic.test.ts`

**Interfaces:**

- Consumes: `deriveWorkLogEntries` and the existing `makeActivity` test helper (already in this file).
- Produces: nothing.

This task adds no production code: marker activities render through the existing `deriveWorkLogEntries` path (their kinds are not in its skip list). The test locks that behavior in so a future skip-list change can't silently hide the markers.

- [ ] **Step 1: Write the test**

Add inside the existing `describe("deriveWorkLogEntries", ...)` block in `apps/web/src/session-logic.test.ts`:

```ts
it("keeps unattended context-clear markers as visible entries", () => {
  const activities: OrchestrationThreadActivity[] = [
    makeActivity({
      id: "ctx-cleared",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "unattended.context-cleared",
      summary: "Context cleared · iteration 1 → 2 · before 517k / 1M (52%)",
      tone: "info",
    }),
    makeActivity({
      id: "ctx-fresh",
      createdAt: "2026-02-23T00:00:02.000Z",
      kind: "unattended.context-fresh",
      summary: "Fresh context · iteration 2 · now 4k / 1M (0.4%)",
      tone: "info",
    }),
  ];

  const entries = deriveWorkLogEntries(activities);
  expect(entries.map((entry) => entry.id)).toEqual(["ctx-cleared", "ctx-fresh"]);
  expect(entries[0]?.label).toContain("Context cleared");
  expect(entries[0]?.sourceActivityKind).toBe("unattended.context-cleared");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vp test run src/session-logic.test.ts -t "context-clear markers"`
Expected: PASS (markers already render through the generic path).

> If this test FAILS (entries are empty), the markers are being filtered. In that case add a guard in `apps/web/src/session-logic.ts` `deriveWorkLogEntries` to explicitly keep them — but do not expect this; the kinds are not skipped today.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/session-logic.test.ts
git commit -m "test(web): lock in inline rendering of unattended context-clear markers"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors for `apps/server`, `apps/web`, `packages/contracts`. (A pre-existing `apps/mobile/src/lib/threadActivity.test.ts:31` error is unrelated and out of scope — confirmed reproducible without these changes.)

- [ ] **Step 2: Lint changed files**

Run:

```bash
pnpm exec vp lint apps/server/src/orchestration/unattendedRun.ts apps/server/src/orchestration/Layers/UnattendedRunReactor.ts
```

Expected: exit 0.

- [ ] **Step 3: Run the affected suites**

Run:

```bash
cd apps/server && pnpm exec vp test run src/orchestration/
cd ../web && pnpm exec vp test run src/session-logic.test.ts
```

Expected: all pass.

- [ ] **Step 4: Manual smoke (optional, requires deploy)**

`pnpm daemon:deploy`, start a short unattended run (totalIterations ≥ 2) on a thread that does enough work to emit a `context-window.updated`, and confirm two inline rows appear at the iteration boundary: a "Context cleared · iteration N → N+1 · before …" row and a "Fresh context · iteration N+1 · now …" row.

---

## Self-Review

**Spec coverage:**

- Inline before/after markers (spec Part A) → Tasks 2, 3, 4 (formatters, before-marker, one-shot fresh-marker). ✓
- Two _measured_ markers → Task 4 reads the first post-clear usage. ✓
- Rendering inline → Task 5 (automatic via `deriveWorkLogEntries`; test locks it in). ✓
- Edge cases (only while running; unknown usage shows "—"/"unknown"; one-shot fresh) → Tasks 2 (unknown-usage test), 3 (`status !== "running"` guard inherited), 4 (one-shot test). ✓
- Earlier wrap (spec Part B) → Task 1. ✓
- Non-goals (no gauge/ClaudeAdapter/contracts changes) → respected; Global Constraints restate them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows an exact command and expected result. ✓

**Type consistency:** `CONTEXT_CLEARED_ACTIVITY_KIND` / `CONTEXT_FRESH_ACTIVITY_KIND`, `buildContextClearedSummary` / `buildContextFreshSummary`, `latestContextUsage`, `awaitingFreshContextReading`, `readContextWindowUsage`, `appendMarker` are named identically wherever referenced across Tasks 2–4. Marker payloads use `usedTokens` / `maxTokens`, matching `readContextWindowUsage` and the `context-window.updated` activity payload. ✓
