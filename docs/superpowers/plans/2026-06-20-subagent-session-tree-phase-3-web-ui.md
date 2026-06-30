# Subagent Session Tree — Phase 3: Web UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subagents first-class, watchable sessions in the web UI. The sidebar gains a chevron on any session row that `hasSubagents`; expanding it lazily subscribes to the Phase 2 `subscribeSubagentTree` endpoint and renders subagents nested under the session — grouped under an iteration node for unattended runs, or directly otherwise, recursively to any depth. Selecting a subagent opens a read-only watch route (`_chat.$environmentId.$threadId.subagent.$subagentRootItemId`) that subscribes to `subscribeSubagent`, renders the subagent transcript live via the existing timeline derivation with **no composer**, and shows a "Subagent finished" banner once the subagent's status leaves `inProgress`. The inline `SubagentCard` in `MessagesTimeline` becomes a compact ref chip linking to the watch route.

**Architecture:** This is the web-only phase. Phases 1 & 2 already (a) excluded subagent-child activities from the parent thread snapshot/stream and (b) added two new server RPC endpoints. **Critical:** the parent `subscribeThread` stream no longer carries subagent-child activities, so this phase MUST source all subagent data from `subscribeSubagentTree` (compact refs for the sidebar) and `subscribeSubagent` (direct-child transcript activities for the watch view). We mirror the existing ref-counted `retainThreadDetailSubscription` machinery in `service.ts` for both new subscriptions, add new keyed-map slices + sync actions + selectors to the Zustand `store.ts`, add wrappers to the shared `wsRpcClient`, add in-memory expand state to `uiStateStore`, and build three new components plus one route. We deliberately do NOT thread a `readOnly` prop through the 5000-line `ChatView`; instead we author a small `SubagentWatchView` that reuses the timeline derivation (`deriveWorkLogEntries` / `deriveTimelineEntries`) and renders `<MessagesTimeline>` directly without the composer JSX.

**Tech Stack:** TypeScript, React, TanStack Router (file-based), Zustand, Vitest + React Testing Library.

> **Test runner note:** This repo runs web tests through `vp` (`vite-plus`). Test files import from `"vite-plus/test"`, not `"vitest"`. The plan's test commands use `pnpm --filter @t3tools/web test <pattern>`; if your harness prefers the workspace script directly, `cd apps/web && pnpm test <pattern>` is equivalent. Typecheck is `npx tsgo --noEmit` from `apps/web`. Lint is `pnpm lint` from the repo root. `vp check` must pass before the feature is considered done.

> **Dependency note:** Phases 1 & 2 introduce the contract types referenced below (`OrchestrationSubagentRef`, `OrchestrationSubagentTreeStreamItem`, `OrchestrationSubagentActivitiesStreamItem`, the `hasSubagents`/`liveSubagentCount` fields on `OrchestrationThreadShell`, and the `ORCHESTRATION_WS_METHODS.subscribeSubagentTree` / `subscribeSubagent` method ids). This phase assumes those exist. If a step's typecheck fails because a contract symbol is missing, Phases 1 & 2 are not merged yet — stop and confirm before stubbing anything.

---

## Locked contract surface (from Phase 2 — use EXACT names)

These already exist after Phase 2. Do not redefine them; import them.

```ts
// from @t3tools/contracts
OrchestrationSubagentRef = {
  threadId: ThreadId;
  rootItemId: string;
  parentItemId: string | null;
  label: string;
  subagentType: string;
  description: string | null;
  status: "inProgress" | "completed" | "failed" | "declined";
  iteration: number | null;
  turnId: TurnId | null;
  depth: number;
  childSubagentCount: number;
  createdAt: string;
  updatedAt: string;
};

OrchestrationSubagentTreeStreamItem =
  | { kind: "snapshot"; snapshot: { snapshotSequence: number; threadId: ThreadId; refs: OrchestrationSubagentRef[] } }
  | { kind: "ref-changed"; ref: OrchestrationSubagentRef }
  | { kind: "ref-removed"; threadId: ThreadId; rootItemId: string };

OrchestrationSubagentActivitiesStreamItem =
  | { kind: "snapshot"; snapshot: { snapshotSequence: number; threadId: ThreadId; rootItemId: string; activities: OrchestrationThreadActivity[] } }
  | { kind: "event"; event: OrchestrationEvent /* a thread.activity-appended whose activity.parentItemId === rootItemId */ };

// ORCHESTRATION_WS_METHODS additions:
//   subscribeSubagentTree: "orchestration.subscribeSubagentTree"  input { threadId }
//   subscribeSubagent:     "orchestration.subscribeSubagent"      input { threadId, rootItemId }

// OrchestrationThreadShell now carries: hasSubagents: boolean; liveSubagentCount: number;
```

---

## Task 1: Web `SidebarThreadSummary` + `mapThreadShell` carry `hasSubagents` / `liveSubagentCount`

**Files:**

- Modify: `apps/web/src/types.ts` (`SidebarThreadSummary` ~146-163; also `ThreadShell` ~123-139 to keep mapping parallel — optional but `ThreadShell` does not need it, only the summary does)
- Modify: `apps/web/src/store.ts` (`mapThreadShell` ~262-317, the `summary` literal ~293-310)
- Test: `apps/web/src/store.test.ts`

### Steps

- [ ] **Step 1** (test first): Add a failing test to `apps/web/src/store.test.ts` proving `syncServerShellSnapshot` populates `hasSubagents` / `liveSubagentCount` on the sidebar summary. The test file already imports `applyShellEvent`, `selectEnvironmentState`, `selectThreadByRef` and uses `vite-plus/test`. Find the existing shell-snapshot/`selectSidebarThreadSummaryByRef` usage near the top and add a test in the relevant `describe`. Append this `it` block (adjust the `makeShellThread`/snapshot helper names to whatever the file already uses for building an `OrchestrationThreadShell`; if none exists, build the shell inline). The key assertions:

```ts
it("carries hasSubagents and liveSubagentCount onto the sidebar summary", () => {
  const environmentId = localEnvironmentId;
  const threadId = ThreadId.make("thread-subagents");
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    updatedAt: "2026-06-20T00:00:00.000Z",
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Has subagents",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude-code"),
          model: DEFAULT_MODEL,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        session: null,
        latestTurn: null,
        createdAt: "2026-06-20T00:00:00.000Z",
        archivedAt: null,
        updatedAt: "2026-06-20T00:00:00.000Z",
        branch: null,
        worktreePath: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        hasSubagents: true,
        liveSubagentCount: 2,
      } as unknown as OrchestrationShellSnapshot["threads"][number],
    ],
  } as unknown as OrchestrationShellSnapshot;

  const state = syncServerShellSnapshot(
    { activeEnvironmentId: environmentId, environmentStateById: {} },
    snapshot,
    environmentId,
  );
  const summary = selectSidebarThreadSummaryByRef(state, scopeThreadRef(environmentId, threadId));
  expect(summary?.hasSubagents).toBe(true);
  expect(summary?.liveSubagentCount).toBe(2);
});
```

Add `syncServerShellSnapshot` and `selectSidebarThreadSummaryByRef` to the imports from `"./store"` and `OrchestrationShellSnapshot` to the `@t3tools/contracts` import block if not already present. (`scopeThreadRef` is already imported at line 1.)

Run it and confirm it FAILS (`hasSubagents`/`liveSubagentCount` are `undefined`):

```
pnpm --filter @t3tools/web test store.test
```

Expected: FAIL on the new `it`.

- [ ] **Step 2**: Add the two fields to `SidebarThreadSummary` in `apps/web/src/types.ts`. The current interface ends:

```ts
export interface SidebarThreadSummary {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
}
```

Add the two fields after `hasActionableProposedPlan`:

```ts
  hasActionableProposedPlan: boolean;
  hasSubagents: boolean;
  liveSubagentCount: number;
}
```

- [ ] **Step 3**: Populate them in `mapThreadShell` in `apps/web/src/store.ts`. The `summary` object literal currently is:

```ts
const summary: SidebarThreadSummary = {
  id: thread.id,
  environmentId,
  projectId: thread.projectId,
  title: thread.title,
  interactionMode: thread.interactionMode,
  session,
  createdAt: thread.createdAt,
  archivedAt: thread.archivedAt,
  updatedAt: thread.updatedAt,
  latestTurn: thread.latestTurn,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  latestUserMessageAt: thread.latestUserMessageAt,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  hasActionableProposedPlan: thread.hasActionableProposedPlan,
};
```

Add the two fields after `hasActionableProposedPlan`:

```ts
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    hasSubagents: thread.hasSubagents,
    liveSubagentCount: thread.liveSubagentCount,
  };
```

- [ ] **Step 4**: Re-run the test; confirm PASS:

```
pnpm --filter @t3tools/web test store.test
```

Expected: PASS. Then typecheck:

```
cd apps/web && npx tsgo --noEmit
```

Expected: no new errors. (If `OrchestrationThreadShell` does not have `hasSubagents`/`liveSubagentCount`, Phase 1/2 are not merged — stop.)

- [ ] **Step 5** (Commit):

```
git add apps/web/src/types.ts apps/web/src/store.ts apps/web/src/store.test.ts
git commit -m "feat(web): carry hasSubagents/liveSubagentCount onto sidebar thread summary"
```

---

## Task 2: `wsRpcClient` wrappers `subscribeSubagentTree` / `subscribeSubagent`

**Files:**

- Modify: `packages/client-runtime/src/wsRpcClient.ts` (interface `WsRpcClient.orchestration` ~182-191; implementation `orchestration:` object ~415-438)
- Test: typecheck-only (there is no dedicated `wsRpcClient.test.ts`; the mock in `apps/web/src/environments/runtime/service.threadSubscriptions.test.ts` exercises the shape and is updated in Task 4).

### Steps

- [ ] **Step 1**: Add the two interface entries. The current `orchestration` block of the `WsRpcClient` interface is:

```ts
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getArchivedShellSnapshot: RpcUnaryNoArgMethod<
      typeof ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot
    >;
    readonly subscribeShell: RpcStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeShell>;
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
  };
```

Add the two methods after `subscribeThread`:

```ts
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
    readonly subscribeSubagentTree: RpcInputStreamMethod<
      typeof ORCHESTRATION_WS_METHODS.subscribeSubagentTree
    >;
    readonly subscribeSubagent: RpcInputStreamMethod<
      typeof ORCHESTRATION_WS_METHODS.subscribeSubagent
    >;
  };
```

(`RpcInputStreamMethod` is the existing helper at ~54-61 that produces `(input, listener, options?) => () => void`; it infers the input + event types from the protocol client, so no manual typing is needed.)

- [ ] **Step 2**: Add the two implementation wrappers. The current `orchestration:` object in `createWsRpcClient` ends:

```ts
      subscribeThread: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
          listener,
          subscriptionOptions(options, ORCHESTRATION_WS_METHODS.subscribeThread),
        ),
    },
  };
}
```

Add after `subscribeThread`:

```ts
      subscribeThread: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
          listener,
          subscriptionOptions(options, ORCHESTRATION_WS_METHODS.subscribeThread),
        ),
      subscribeSubagentTree: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeSubagentTree](input),
          listener,
          subscriptionOptions(options, ORCHESTRATION_WS_METHODS.subscribeSubagentTree),
        ),
      subscribeSubagent: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeSubagent](input),
          listener,
          subscriptionOptions(options, ORCHESTRATION_WS_METHODS.subscribeSubagent),
        ),
    },
  };
}
```

- [ ] **Step 3**: Typecheck the package:

```
cd packages/client-runtime && npx tsgo --noEmit
```

Expected: no errors. (If `ORCHESTRATION_WS_METHODS.subscribeSubagentTree`/`subscribeSubagent` are missing, Phase 2 is not merged — stop.)

- [ ] **Step 4** (Commit):

```
git add packages/client-runtime/src/wsRpcClient.ts
git commit -m "feat(client-runtime): add subscribeSubagentTree/subscribeSubagent client wrappers"
```

---

## Task 3: Store slices, sync actions, and selectors for subagent refs + activities

**Files:**

- Modify: `apps/web/src/store.ts` (`EnvironmentState` ~42-97; `initialEnvironmentState` ~104-122; new reducer functions; `AppStore` interface ~2038-2058; `useStore` create ~2060-2079)
- Modify: `apps/web/src/storeSelectors.ts` (add two selector factories)
- Test: `apps/web/src/store.test.ts`

We add two keyed-map slices mirroring the `activityByThreadId` pattern. `subagentRefsByThreadId` holds the flat ref array per thread (replaced wholesale on snapshot, upserted/removed on delta). `subagentActivitiesByKey` holds the watch transcript keyed `${threadId}::${rootItemId}` (replaced on snapshot, appended on event).

### Steps

- [ ] **Step 1** (test first): Add reducer unit tests to `apps/web/src/store.test.ts`. Import the new reducer functions and `OrchestrationSubagentRef` / `OrchestrationThreadActivity` types. Add:

```ts
import {
  syncSubagentTreeSnapshot,
  applySubagentTreeDelta,
  syncSubagentActivitiesSnapshot,
  appendSubagentActivity,
} from "./store";
import { createSubagentRefsSelector, createSubagentActivitiesSelector } from "./storeSelectors";
import type { OrchestrationSubagentRef, OrchestrationThreadActivity } from "@t3tools/contracts";

function makeRef(overrides: Partial<OrchestrationSubagentRef> = {}): OrchestrationSubagentRef {
  return {
    threadId: ThreadId.make("thread-1"),
    rootItemId: "root-1",
    parentItemId: null,
    label: "code-reviewer: review the diff",
    subagentType: "code-reviewer",
    description: "review the diff",
    status: "inProgress",
    iteration: null,
    turnId: null,
    depth: 0,
    childSubagentCount: 0,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeSubagentActivity(
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make("act-1"),
    tone: "info",
    kind: "tool.completed",
    summary: "Subagent message",
    payload: { itemType: "assistant_message", status: "completed" },
    turnId: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("subagent tree reducers", () => {
  const environmentId = localEnvironmentId;
  const threadId = ThreadId.make("thread-1");

  it("replaces the ref array on snapshot", () => {
    const refA = makeRef({ rootItemId: "root-a" });
    const refB = makeRef({ rootItemId: "root-b" });
    let state: AppState = { activeEnvironmentId: environmentId, environmentStateById: {} };
    state = syncSubagentTreeSnapshot(state, environmentId, threadId, [refA]);
    expect(createSubagentRefsSelector(environmentId, threadId)(state)).toEqual([refA]);
    state = syncSubagentTreeSnapshot(state, environmentId, threadId, [refB]);
    expect(createSubagentRefsSelector(environmentId, threadId)(state)).toEqual([refB]);
  });

  it("upserts a ref on ref-changed delta", () => {
    const ref = makeRef({ rootItemId: "root-a", status: "inProgress" });
    let state: AppState = { activeEnvironmentId: environmentId, environmentStateById: {} };
    state = syncSubagentTreeSnapshot(state, environmentId, threadId, [ref]);
    state = applySubagentTreeDelta(state, environmentId, {
      kind: "ref-changed",
      ref: { ...ref, status: "completed" },
    });
    expect(createSubagentRefsSelector(environmentId, threadId)(state)[0]?.status).toBe("completed");
    // upsert appends a brand-new ref
    state = applySubagentTreeDelta(state, environmentId, {
      kind: "ref-changed",
      ref: makeRef({ rootItemId: "root-b" }),
    });
    expect(createSubagentRefsSelector(environmentId, threadId)(state)).toHaveLength(2);
  });

  it("removes a ref on ref-removed delta", () => {
    const refA = makeRef({ rootItemId: "root-a" });
    const refB = makeRef({ rootItemId: "root-b" });
    let state: AppState = { activeEnvironmentId: environmentId, environmentStateById: {} };
    state = syncSubagentTreeSnapshot(state, environmentId, threadId, [refA, refB]);
    state = applySubagentTreeDelta(state, environmentId, {
      kind: "ref-removed",
      threadId,
      rootItemId: "root-a",
    });
    const refs = createSubagentRefsSelector(environmentId, threadId)(state);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.rootItemId).toBe("root-b");
  });

  it("replaces activities on snapshot and appends on event", () => {
    const rootItemId = "root-a";
    const first = makeSubagentActivity({ id: EventId.make("act-1") });
    let state: AppState = { activeEnvironmentId: environmentId, environmentStateById: {} };
    state = syncSubagentActivitiesSnapshot(state, environmentId, threadId, rootItemId, [first]);
    expect(createSubagentActivitiesSelector(environmentId, threadId, rootItemId)(state)).toEqual([
      first,
    ]);
    const second = makeSubagentActivity({ id: EventId.make("act-2") });
    state = appendSubagentActivity(state, environmentId, threadId, rootItemId, second);
    expect(
      createSubagentActivitiesSelector(environmentId, threadId, rootItemId)(state),
    ).toHaveLength(2);
    // appending the same id again is idempotent (dedupe by id)
    state = appendSubagentActivity(state, environmentId, threadId, rootItemId, second);
    expect(
      createSubagentActivitiesSelector(environmentId, threadId, rootItemId)(state),
    ).toHaveLength(2);
  });
});
```

Add `EventId` to the `@t3tools/contracts` import in the test (it is already imported). Run; confirm FAIL (imports don't resolve yet):

```
pnpm --filter @t3tools/web test store.test
```

Expected: FAIL (module has no exported member `syncSubagentTreeSnapshot`, etc.).

- [ ] **Step 2**: Add the contract type imports to the top of `apps/web/src/store.ts`. The existing `@t3tools/contracts` import block (lines 1-20) lists types like `OrchestrationThreadActivity`. Add the two new ones:

```ts
  OrchestrationThreadActivity,
  OrchestrationSubagentRef,
  OrchestrationSubagentTreeStreamItem,
```

(Add `OrchestrationSubagentRef` and `OrchestrationSubagentTreeStreamItem` alphabetically near the other `Orchestration*` imports.)

- [ ] **Step 3**: Add the two slices to `EnvironmentState` (after `sidebarThreadSummaryById`, before `bootstrapComplete`):

```ts
sidebarThreadSummaryById: Record<ThreadId, SidebarThreadSummary>;

// ---------------------------------------------------------------------------
// Subagent tree + transcript — written ONLY by the subagent subscriptions
// (service.ts retainSubagentTreeSubscription / retainSubagentActivitiesSubscription).
// After Phase 1 these are NOT present in the parent thread snapshot/stream;
// they arrive exclusively via subscribeSubagentTree / subscribeSubagent.
// ---------------------------------------------------------------------------
subagentRefsByThreadId: Record<ThreadId, OrchestrationSubagentRef[]>;
subagentActivitiesByKey: Record<string, OrchestrationThreadActivity[]>;

bootstrapComplete: boolean;
```

- [ ] **Step 4**: Add them to `initialEnvironmentState`:

```ts
  sidebarThreadSummaryById: {},
  subagentRefsByThreadId: {},
  subagentActivitiesByKey: {},
  bootstrapComplete: false,
```

- [ ] **Step 5**: Add a key helper + the four reducer functions. Place them near `syncServerThreadDetail` (~1162). Use `getStoredEnvironmentState` / `commitEnvironmentState` exactly as the existing reducers do:

```ts
export function subagentActivitiesKey(threadId: ThreadId, rootItemId: string): string {
  return `${threadId}::${rootItemId}`;
}

export function syncSubagentTreeSnapshot(
  state: AppState,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  refs: ReadonlyArray<OrchestrationSubagentRef>,
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  return commitEnvironmentState(state, environmentId, {
    ...environmentState,
    subagentRefsByThreadId: {
      ...environmentState.subagentRefsByThreadId,
      [threadId]: [...refs],
    },
  });
}

export function applySubagentTreeDelta(
  state: AppState,
  environmentId: EnvironmentId,
  delta: Exclude<OrchestrationSubagentTreeStreamItem, { kind: "snapshot" }>,
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  if (delta.kind === "ref-removed") {
    const current = environmentState.subagentRefsByThreadId[delta.threadId];
    if (!current) {
      return state;
    }
    const next = current.filter((ref) => ref.rootItemId !== delta.rootItemId);
    if (next.length === current.length) {
      return state;
    }
    return commitEnvironmentState(state, environmentId, {
      ...environmentState,
      subagentRefsByThreadId: {
        ...environmentState.subagentRefsByThreadId,
        [delta.threadId]: next,
      },
    });
  }
  // kind === "ref-changed"
  const ref = delta.ref;
  const current = environmentState.subagentRefsByThreadId[ref.threadId] ?? [];
  const index = current.findIndex((existing) => existing.rootItemId === ref.rootItemId);
  const next = index >= 0 ? current.with(index, ref) : [...current, ref];
  return commitEnvironmentState(state, environmentId, {
    ...environmentState,
    subagentRefsByThreadId: {
      ...environmentState.subagentRefsByThreadId,
      [ref.threadId]: next,
    },
  });
}

export function syncSubagentActivitiesSnapshot(
  state: AppState,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  rootItemId: string,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  const key = subagentActivitiesKey(threadId, rootItemId);
  return commitEnvironmentState(state, environmentId, {
    ...environmentState,
    subagentActivitiesByKey: {
      ...environmentState.subagentActivitiesByKey,
      [key]: [...activities],
    },
  });
}

export function appendSubagentActivity(
  state: AppState,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  rootItemId: string,
  activity: OrchestrationThreadActivity,
): AppState {
  const environmentState = getStoredEnvironmentState(state, environmentId);
  const key = subagentActivitiesKey(threadId, rootItemId);
  const current = environmentState.subagentActivitiesByKey[key] ?? [];
  if (current.some((existing) => existing.id === activity.id)) {
    return state;
  }
  return commitEnvironmentState(state, environmentId, {
    ...environmentState,
    subagentActivitiesByKey: {
      ...environmentState.subagentActivitiesByKey,
      [key]: [...current, activity],
    },
  });
}
```

- [ ] **Step 6**: Wire the four actions into the store. Add to the `AppStore` interface (after `setThreadBranch`):

```ts
  syncSubagentTreeSnapshot: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    refs: ReadonlyArray<OrchestrationSubagentRef>,
  ) => void;
  applySubagentTreeDelta: (
    environmentId: EnvironmentId,
    delta: Exclude<OrchestrationSubagentTreeStreamItem, { kind: "snapshot" }>,
  ) => void;
  syncSubagentActivitiesSnapshot: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    rootItemId: string,
    activities: ReadonlyArray<OrchestrationThreadActivity>,
  ) => void;
  appendSubagentActivity: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    rootItemId: string,
    activity: OrchestrationThreadActivity,
  ) => void;
```

And to the `create<AppStore>` object (after `setThreadBranch`):

```ts
  syncSubagentTreeSnapshot: (environmentId, threadId, refs) =>
    set((state) => syncSubagentTreeSnapshot(state, environmentId, threadId, refs)),
  applySubagentTreeDelta: (environmentId, delta) =>
    set((state) => applySubagentTreeDelta(state, environmentId, delta)),
  syncSubagentActivitiesSnapshot: (environmentId, threadId, rootItemId, activities) =>
    set((state) =>
      syncSubagentActivitiesSnapshot(state, environmentId, threadId, rootItemId, activities),
    ),
  appendSubagentActivity: (environmentId, threadId, rootItemId, activity) =>
    set((state) => appendSubagentActivity(state, environmentId, threadId, rootItemId, activity)),
```

- [ ] **Step 7**: Add the two selectors to `apps/web/src/storeSelectors.ts`. Update the import to add `EnvironmentId` + the activity/ref types and `subagentActivitiesKey`. The file currently imports from `./store`:

```ts
import { type ScopedProjectRef, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { selectEnvironmentState, type AppState, type EnvironmentState } from "./store";
```

Change/extend to:

```ts
import {
  type EnvironmentId,
  type OrchestrationSubagentRef,
  type OrchestrationThreadActivity,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  selectEnvironmentState,
  subagentActivitiesKey,
  type AppState,
  type EnvironmentState,
} from "./store";
```

Append the two factories at the end of the file. Use module-level empty constants so the selector returns a stable reference when nothing exists (mirroring the `EMPTY_*` pattern elsewhere in the codebase, avoiding new array identities on every render):

```ts
const EMPTY_SUBAGENT_REFS: OrchestrationSubagentRef[] = [];
const EMPTY_SUBAGENT_ACTIVITIES: OrchestrationThreadActivity[] = [];

export function createSubagentRefsSelector(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): (state: AppState) => OrchestrationSubagentRef[] {
  return (state) =>
    selectEnvironmentState(state, environmentId).subagentRefsByThreadId[threadId] ??
    EMPTY_SUBAGENT_REFS;
}

export function createSubagentActivitiesSelector(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  rootItemId: string,
): (state: AppState) => OrchestrationThreadActivity[] {
  const key = subagentActivitiesKey(threadId, rootItemId);
  return (state) =>
    selectEnvironmentState(state, environmentId).subagentActivitiesByKey[key] ??
    EMPTY_SUBAGENT_ACTIVITIES;
}
```

- [ ] **Step 8**: Re-run the tests; confirm PASS, then typecheck:

```
pnpm --filter @t3tools/web test store.test
cd apps/web && npx tsgo --noEmit
```

Expected: PASS, no type errors.

- [ ] **Step 9** (Commit):

```
git add apps/web/src/store.ts apps/web/src/storeSelectors.ts apps/web/src/store.test.ts
git commit -m "feat(web): add subagent ref + activity store slices, reducers, and selectors"
```

---

## Task 4: `service.ts` ref-counted subscriptions for the subagent tree + activities

**Files:**

- Modify: `apps/web/src/environments/runtime/service.ts` (mirror the thread-detail machinery: entry type ~107-115, maps ~138, key helper ~332-334, attach ~395-419, watch/connection ~422-433, dispose, retain ~566-622, plus `attach*ForEnvironment` calls in `registerConnection` ~1429 and `detachThreadDetailSubscriptionsForEnvironment` in `removeConnection` ~1449)
- Test: `apps/web/src/environments/runtime/service.threadSubscriptions.test.ts` (extend the mock client + add a focused dispatch test; or a new `service.subagentSubscriptions.test.ts` mirroring it)

We mirror `retainThreadDetailSubscription` but keep it lean: the subagent subscriptions are lower-traffic (only while a session is expanded or a subagent is watched) so we use a simple ref-counted map with immediate dispose at refCount 0 (no idle-TTL eviction is required for v1 — the thread-detail eviction machinery exists to keep snapshots warm while navigating, which does not apply here). They DO need the same connection-reattach behavior (`watch*Connection`) so a reconnect re-subscribes.

### Steps

- [ ] **Step 1** (test first): Extend the existing mock in `service.threadSubscriptions.test.ts`. In the `@t3tools/client-runtime` mock's `orchestration` object (currently ~88-95), add:

```ts
    orchestration: {
      dispatchCommand: vi.fn(),
      getTurnDiff: vi.fn(),
      getFullThreadDiff: vi.fn(),
      getArchivedShellSnapshot: vi.fn(),
      subscribeShell: vi.fn(() => () => undefined),
      subscribeThread: mockSubscribeThread,
      subscribeSubagentTree: mockSubscribeSubagentTree,
      subscribeSubagent: mockSubscribeSubagent,
    },
```

Declare the mocks near the top with the others:

```ts
const mockSubscribeSubagentTree = vi.fn();
const mockSubscribeSubagent = vi.fn();
```

Then add a focused test that retaining the tree subscription calls the client method, dispatches a snapshot into the store, and releasing unsubscribes. Mirror how the existing tests drive `mockSubscribeThread` (they capture the listener passed and invoke it). Add:

```ts
it("dispatches subagent tree snapshots into the store and unsubscribes on release", async () => {
  const { retainSubagentTreeSubscription } = await import("./service");
  const { useStore, createSubagentRefsSelector } = await import("~/store");
  const unsubscribe = vi.fn();
  let captured: ((item: unknown) => void) | null = null;
  mockSubscribeSubagentTree.mockImplementation((_input, listener) => {
    captured = listener;
    return unsubscribe;
  });

  // ... bootstrap a connection the same way the existing thread tests do, then:
  const release = retainSubagentTreeSubscription(environmentId, threadId);
  expect(mockSubscribeSubagentTree).toHaveBeenCalledWith({ threadId }, expect.any(Function));

  captured?.({
    kind: "snapshot",
    snapshot: { snapshotSequence: 1, threadId, refs: [makeRef()] },
  });
  expect(createSubagentRefsSelector(environmentId, threadId)(useStore.getState())).toHaveLength(1);

  release();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
```

(Reuse `environmentId`, `threadId`, and the connection-bootstrap helper already present in the file. If wiring a full connection is too heavy, instead write a thinner test in a new `service.subagentSubscriptions.test.ts` that only asserts the dispatch path by stubbing `readEnvironmentConnection`. The connection-bootstrap pattern is already demonstrated by the existing thread-subscription tests in this file — copy it.) Run; confirm FAIL (function not exported yet):

```
pnpm --filter @t3tools/web test service.threadSubscriptions
```

Expected: FAIL.

- [ ] **Step 2**: Add imports + entry types + maps to `service.ts`. Extend the `@t3tools/contracts` import (top of file) with `OrchestrationSubagentRef` and `OrchestrationSubagentTreeStreamItem` and `OrchestrationSubagentActivitiesStreamItem` if a typed listener is desired (the wrapper already infers types, so explicit types are optional). Extend the store import (currently `~/store` brings `useStore`, selectors) — the actions are accessed via `useStore.getState()`, so no extra import is strictly needed.

Add entry types after `ThreadDetailSubscriptionEntry` (~115):

```ts
type SubagentTreeSubscriptionEntry = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
};

type SubagentActivitiesSubscriptionEntry = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rootItemId: string;
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
};
```

Add maps near `threadDetailSubscriptions` (~138):

```ts
const subagentTreeSubscriptions = new Map<string, SubagentTreeSubscriptionEntry>();
const subagentActivitiesSubscriptions = new Map<string, SubagentActivitiesSubscriptionEntry>();
```

- [ ] **Step 3**: Add the tree subscription machinery. Mirror `getThreadDetailSubscriptionKey` / `attachThreadDetailSubscription` / `watchThreadDetailSubscriptionConnection` / `disposeThreadDetailSubscriptionByKey` / `retainThreadDetailSubscription`. Place after `retainThreadDetailSubscription` (~622). `readEnvironmentConnection` and `subscribeEnvironmentConnections` already exist in this file (used by the thread machinery). Use `scopedThreadKey(scopeThreadRef(...))` for the tree key and `${scopedThreadKey}::${rootItemId}` for the activities key.

```ts
function getSubagentTreeSubscriptionKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function attachSubagentTreeSubscription(entry: SubagentTreeSubscriptionEntry): boolean {
  if (entry.unsubscribeConnectionListener !== null) {
    entry.unsubscribeConnectionListener();
    entry.unsubscribeConnectionListener = null;
  }
  if (entry.unsubscribe !== NOOP) {
    return true;
  }
  const connection = readEnvironmentConnection(entry.environmentId);
  if (!connection) {
    return false;
  }
  entry.unsubscribe = connection.client.orchestration.subscribeSubagentTree(
    { threadId: entry.threadId },
    (item) => {
      if (item.kind === "snapshot") {
        useStore
          .getState()
          .syncSubagentTreeSnapshot(entry.environmentId, entry.threadId, item.snapshot.refs);
        return;
      }
      useStore.getState().applySubagentTreeDelta(entry.environmentId, item);
    },
  );
  return true;
}

function watchSubagentTreeSubscriptionConnection(entry: SubagentTreeSubscriptionEntry): void {
  if (entry.unsubscribeConnectionListener !== null) {
    return;
  }
  entry.unsubscribeConnectionListener = subscribeEnvironmentConnections(() => {
    attachSubagentTreeSubscription(entry);
  });
  attachSubagentTreeSubscription(entry);
}

function disposeSubagentTreeSubscriptionByKey(key: string): void {
  const entry = subagentTreeSubscriptions.get(key);
  if (!entry) {
    return;
  }
  entry.unsubscribeConnectionListener?.();
  entry.unsubscribeConnectionListener = null;
  subagentTreeSubscriptions.delete(key);
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
}

export function retainSubagentTreeSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  const key = getSubagentTreeSubscriptionKey(environmentId, threadId);
  const existing = subagentTreeSubscriptions.get(key);
  const entry =
    existing ??
    ({
      environmentId,
      threadId,
      unsubscribe: NOOP,
      unsubscribeConnectionListener: null,
      refCount: 0,
    } satisfies SubagentTreeSubscriptionEntry);
  if (!existing) {
    subagentTreeSubscriptions.set(key, entry);
  }
  entry.refCount += 1;
  if (!attachSubagentTreeSubscription(entry)) {
    watchSubagentTreeSubscriptionConnection(entry);
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0) {
      disposeSubagentTreeSubscriptionByKey(key);
    }
  };
}
```

- [ ] **Step 4**: Add the activities subscription machinery (key includes `rootItemId`, listener dispatches the activity snapshot/event):

```ts
function getSubagentActivitiesSubscriptionKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  rootItemId: string,
): string {
  return `${scopedThreadKey(scopeThreadRef(environmentId, threadId))}::${rootItemId}`;
}

function attachSubagentActivitiesSubscription(entry: SubagentActivitiesSubscriptionEntry): boolean {
  if (entry.unsubscribeConnectionListener !== null) {
    entry.unsubscribeConnectionListener();
    entry.unsubscribeConnectionListener = null;
  }
  if (entry.unsubscribe !== NOOP) {
    return true;
  }
  const connection = readEnvironmentConnection(entry.environmentId);
  if (!connection) {
    return false;
  }
  entry.unsubscribe = connection.client.orchestration.subscribeSubagent(
    { threadId: entry.threadId, rootItemId: entry.rootItemId },
    (item) => {
      if (item.kind === "snapshot") {
        useStore
          .getState()
          .syncSubagentActivitiesSnapshot(
            entry.environmentId,
            entry.threadId,
            entry.rootItemId,
            item.snapshot.activities,
          );
        return;
      }
      if (item.event.type !== "thread.activity-appended") {
        return;
      }
      useStore
        .getState()
        .appendSubagentActivity(
          entry.environmentId,
          entry.threadId,
          entry.rootItemId,
          item.event.payload.activity,
        );
    },
  );
  return true;
}

function watchSubagentActivitiesSubscriptionConnection(
  entry: SubagentActivitiesSubscriptionEntry,
): void {
  if (entry.unsubscribeConnectionListener !== null) {
    return;
  }
  entry.unsubscribeConnectionListener = subscribeEnvironmentConnections(() => {
    attachSubagentActivitiesSubscription(entry);
  });
  attachSubagentActivitiesSubscription(entry);
}

function disposeSubagentActivitiesSubscriptionByKey(key: string): void {
  const entry = subagentActivitiesSubscriptions.get(key);
  if (!entry) {
    return;
  }
  entry.unsubscribeConnectionListener?.();
  entry.unsubscribeConnectionListener = null;
  subagentActivitiesSubscriptions.delete(key);
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
}

export function retainSubagentActivitiesSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  rootItemId: string,
): () => void {
  const key = getSubagentActivitiesSubscriptionKey(environmentId, threadId, rootItemId);
  const existing = subagentActivitiesSubscriptions.get(key);
  const entry =
    existing ??
    ({
      environmentId,
      threadId,
      rootItemId,
      unsubscribe: NOOP,
      unsubscribeConnectionListener: null,
      refCount: 0,
    } satisfies SubagentActivitiesSubscriptionEntry);
  if (!existing) {
    subagentActivitiesSubscriptions.set(key, entry);
  }
  entry.refCount += 1;
  if (!attachSubagentActivitiesSubscription(entry)) {
    watchSubagentActivitiesSubscriptionConnection(entry);
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0) {
      disposeSubagentActivitiesSubscriptionByKey(key);
    }
  };
}
```

> NOTE on the event payload shape: the activities event is a `thread.activity-appended` whose payload (`ThreadActivityAppendedPayload`, contracts ~1107) carries `{ threadId, activity, ... }`. Read `item.event.payload.activity`. Confirm the exact field name against `packages/contracts/src/orchestration.ts` `ThreadActivityAppendedPayload` when implementing; adjust if it differs.

- [ ] **Step 5**: On environment teardown, detach both new subscription kinds so reconnect re-attaches. In `removeConnection` (~1449, after `detachThreadDetailSubscriptionsForEnvironment(environmentId)`), add detach loops:

```ts
detachThreadDetailSubscriptionsForEnvironment(environmentId);
for (const entry of subagentTreeSubscriptions.values()) {
  if (entry.environmentId !== environmentId) continue;
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
  watchSubagentTreeSubscriptionConnection(entry);
}
for (const entry of subagentActivitiesSubscriptions.values()) {
  if (entry.environmentId !== environmentId) continue;
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
  watchSubagentActivitiesSubscriptionConnection(entry);
}
```

And in `registerConnection` (~1429, after `attachThreadDetailSubscriptionsForEnvironment`), re-attach:

```ts
attachThreadDetailSubscriptionsForEnvironment(connection.environmentId);
for (const entry of subagentTreeSubscriptions.values()) {
  if (entry.environmentId === connection.environmentId) {
    attachSubagentTreeSubscription(entry);
  }
}
for (const entry of subagentActivitiesSubscriptions.values()) {
  if (entry.environmentId === connection.environmentId) {
    attachSubagentActivitiesSubscription(entry);
  }
}
```

- [ ] **Step 6**: Re-run the service test + typecheck:

```
pnpm --filter @t3tools/web test service.threadSubscriptions
cd apps/web && npx tsgo --noEmit
```

Expected: PASS, no type errors.

- [ ] **Step 7** (Commit):

```
git add apps/web/src/environments/runtime/service.ts apps/web/src/environments/runtime/service.threadSubscriptions.test.ts
git commit -m "feat(web): add ref-counted subagent tree + activities subscriptions in service"
```

---

## Task 5: `uiStateStore` subagent expand state

**Files:**

- Modify: `apps/web/src/uiStateStore.ts` (`UiProjectState` ~26-29 — add a sibling slice; `UiState` ~40; `initialState` ~55-61; reducers near `toggleProject`/`setProjectExpanded` ~569-591; `UiStateStore` interface ~636-650; `create` ~652-670)
- Test: `apps/web/src/uiStateStore.test.ts` (create if absent, mirroring `store.test.ts` style with `vite-plus/test`)

In-memory only. Do NOT add `subagentExpandedById` to `PersistedUiState` or the `persistState`/`readPersistedState` paths — subagent expansion is ephemeral. Default COLLAPSED (`?? false`), the opposite of projects (which default `?? true`).

### Steps

- [ ] **Step 1** (test first): Create `apps/web/src/uiStateStore.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import { setSubagentExpanded, toggleSubagent } from "./uiStateStore";

const baseState = {
  projectExpandedById: {},
  projectOrder: [],
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  defaultAdvertisedEndpointKey: null,
  subagentExpandedById: {},
};

describe("subagent expand state", () => {
  it("defaults to collapsed and toggles to expanded", () => {
    const next = toggleSubagent(baseState, "thread-key");
    expect(next.subagentExpandedById["thread-key"]).toBe(true);
  });

  it("toggles an expanded entry back to collapsed", () => {
    const expanded = setSubagentExpanded(baseState, "thread-key", true);
    const collapsed = toggleSubagent(expanded, "thread-key");
    expect(collapsed.subagentExpandedById["thread-key"]).toBe(false);
  });

  it("setSubagentExpanded is a no-op when already in the target state", () => {
    const next = setSubagentExpanded(baseState, "thread-key", false);
    expect(next).toBe(baseState);
  });
});
```

Run; confirm FAIL:

```
pnpm --filter @t3tools/web test uiStateStore.test
```

Expected: FAIL (no exported member `toggleSubagent`).

- [ ] **Step 2**: Add the slice. Extend `UiProjectState` is not ideal (it is project-scoped); instead add the field directly to `UiState`. Change:

```ts
export interface UiState extends UiProjectState, UiThreadState, UiEndpointState {}
```

to introduce a small interface and extend it:

```ts
export interface UiSubagentState {
  subagentExpandedById: Record<string, boolean>;
}

export interface UiState extends UiProjectState, UiThreadState, UiEndpointState, UiSubagentState {}
```

Add to `initialState`:

```ts
const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  defaultAdvertisedEndpointKey: null,
  subagentExpandedById: {},
};
```

- [ ] **Step 3**: Add the reducers after `setProjectExpanded` (~591). Note the **default `?? false`** (collapsed):

```ts
export function toggleSubagent(state: UiState, key: string): UiState {
  const expanded = state.subagentExpandedById[key] ?? false;
  return {
    ...state,
    subagentExpandedById: {
      ...state.subagentExpandedById,
      [key]: !expanded,
    },
  };
}

export function setSubagentExpanded(state: UiState, key: string, expanded: boolean): UiState {
  if ((state.subagentExpandedById[key] ?? false) === expanded) {
    return state;
  }
  return {
    ...state,
    subagentExpandedById: {
      ...state.subagentExpandedById,
      [key]: expanded,
    },
  };
}
```

- [ ] **Step 4**: Wire into the store interface + `create`. Add to `UiStateStore` (after `setProjectExpanded`):

```ts
  toggleSubagent: (key: string) => void;
  setSubagentExpanded: (key: string, expanded: boolean) => void;
```

Add to the `create<UiStateStore>` object (after `setProjectExpanded`):

```ts
  toggleSubagent: (key) => set((state) => toggleSubagent(state, key)),
  setSubagentExpanded: (key, expanded) => set((state) => setSubagentExpanded(state, key, expanded)),
```

> Because `subagentExpandedById` is not persisted, `persistState` (which only reads `projectExpandedById`, `projectOrder`, `defaultAdvertisedEndpointKey`, `threadChangedFilesExpandedById`) needs no change. Leave it untouched.

- [ ] **Step 5**: Re-run; confirm PASS, then typecheck:

```
pnpm --filter @t3tools/web test uiStateStore.test
cd apps/web && npx tsgo --noEmit
```

Expected: PASS, no type errors.

- [ ] **Step 6** (Commit):

```
git add apps/web/src/uiStateStore.ts apps/web/src/uiStateStore.test.ts
git commit -m "feat(web): add in-memory subagent expand state to uiStateStore"
```

---

## Task 6: Sidebar chevron + recursive `SidebarSubagentTree`

**Files:**

- Create: `apps/web/src/components/sidebar/SidebarSubagentTree.tsx`
- Create: `apps/web/src/components/sidebar/SidebarSubagentTree.logic.ts` (pure grouping/nesting helper — keeps the testable derivation out of the component)
- Modify: `apps/web/src/components/Sidebar.tsx` (`SidebarThreadRow` — add chevron on rows with `hasSubagents`, render `<SidebarSubagentTree>` inside the row's `SidebarMenuSubItem` after the button, gated by expand flag)
- Test: `apps/web/src/components/sidebar/SidebarSubagentTree.logic.test.ts`

**Expand keys** (per the locked contract):

- Session group (the chevron on the thread row): `threadKey` = `scopedThreadKey(scopeThreadRef(environmentId, threadId))`.
- Iteration node: `${threadKey}::iter::${iteration}`.
- Nested subagent node: `${threadKey}::sa::${rootItemId}`.

### Steps

- [ ] **Step 1** (test first — pure derivation): Create `apps/web/src/components/sidebar/SidebarSubagentTree.logic.test.ts`. The grouping logic: given a flat `OrchestrationSubagentRef[]` for a thread, build a forest. Top-level refs are those whose `parentItemId === null`. If any top-level ref has `iteration != null`, the top level is grouped under iteration nodes (sorted ascending); otherwise top-level refs render directly. Children of a ref are refs whose `parentItemId === ref.rootItemId`.

```ts
import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import type { OrchestrationSubagentRef } from "@t3tools/contracts";

import { buildSubagentForest, childRefsOf } from "./SidebarSubagentTree.logic";

function makeRef(overrides: Partial<OrchestrationSubagentRef>): OrchestrationSubagentRef {
  return {
    threadId: ThreadId.make("thread-1"),
    rootItemId: "root",
    parentItemId: null,
    label: "x: y",
    subagentType: "x",
    description: "y",
    status: "inProgress",
    iteration: null,
    turnId: null,
    depth: 0,
    childSubagentCount: 0,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSubagentForest", () => {
  it("returns ungrouped top-level refs when iteration is null", () => {
    const a = makeRef({ rootItemId: "a" });
    const b = makeRef({ rootItemId: "b" });
    const forest = buildSubagentForest([a, b]);
    expect(forest.kind).toBe("ungrouped");
    if (forest.kind === "ungrouped") {
      expect(forest.refs.map((r) => r.rootItemId)).toEqual(["a", "b"]);
    }
  });

  it("groups top-level refs by iteration ascending when iteration is set", () => {
    const a = makeRef({ rootItemId: "a", iteration: 2 });
    const b = makeRef({ rootItemId: "b", iteration: 1 });
    const forest = buildSubagentForest([a, b]);
    expect(forest.kind).toBe("grouped");
    if (forest.kind === "grouped") {
      expect(forest.groups.map((g) => g.iteration)).toEqual([1, 2]);
      expect(forest.groups[0]?.refs.map((r) => r.rootItemId)).toEqual(["b"]);
    }
  });

  it("childRefsOf returns refs whose parentItemId matches", () => {
    const parent = makeRef({ rootItemId: "p" });
    const child = makeRef({ rootItemId: "c", parentItemId: "p", depth: 1 });
    const other = makeRef({ rootItemId: "o" });
    expect(childRefsOf([parent, child, other], "p").map((r) => r.rootItemId)).toEqual(["c"]);
  });
});
```

Run; confirm FAIL:

```
pnpm --filter @t3tools/web test SidebarSubagentTree.logic
```

Expected: FAIL.

- [ ] **Step 2**: Create `apps/web/src/components/sidebar/SidebarSubagentTree.logic.ts`:

```ts
import type { OrchestrationSubagentRef } from "@t3tools/contracts";

export interface SubagentIterationGroup {
  readonly iteration: number;
  readonly refs: OrchestrationSubagentRef[];
}

export type SubagentForest =
  | { readonly kind: "ungrouped"; readonly refs: OrchestrationSubagentRef[] }
  | { readonly kind: "grouped"; readonly groups: SubagentIterationGroup[] };

/** Top-level refs are those with no parent (parentItemId === null). */
export function topLevelRefs(
  refs: ReadonlyArray<OrchestrationSubagentRef>,
): OrchestrationSubagentRef[] {
  return refs.filter((ref) => ref.parentItemId === null);
}

/** Direct children of a ref: refs whose parentItemId equals the given rootItemId. */
export function childRefsOf(
  refs: ReadonlyArray<OrchestrationSubagentRef>,
  rootItemId: string,
): OrchestrationSubagentRef[] {
  return refs.filter((ref) => ref.parentItemId === rootItemId);
}

export function buildSubagentForest(refs: ReadonlyArray<OrchestrationSubagentRef>): SubagentForest {
  const top = topLevelRefs(refs);
  const anyIteration = top.some((ref) => ref.iteration !== null);
  if (!anyIteration) {
    return { kind: "ungrouped", refs: top };
  }
  const byIteration = new Map<number, OrchestrationSubagentRef[]>();
  for (const ref of top) {
    const iteration = ref.iteration ?? 0;
    const bucket = byIteration.get(iteration);
    if (bucket) {
      bucket.push(ref);
    } else {
      byIteration.set(iteration, [ref]);
    }
  }
  const groups = [...byIteration.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([iteration, groupRefs]) => ({ iteration, refs: groupRefs }));
  return { kind: "grouped", groups };
}
```

Run; confirm PASS:

```
pnpm --filter @t3tools/web test SidebarSubagentTree.logic
```

Expected: PASS.

- [ ] **Step 3**: Create the recursive component `apps/web/src/components/sidebar/SidebarSubagentTree.tsx`. It reads refs via `createSubagentRefsSelector`, navigates via `useNavigate`, and reads/toggles expansion via `useUiStateStore`. Use the exact sidebar primitives (`SidebarMenuSub`, `SidebarMenuSubItem`, `SidebarMenuSubButton`) and the project chevron className convention.

```tsx
import { useMemo } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationSubagentRef } from "@t3tools/contracts";

import { useStore } from "../../store";
import { createSubagentRefsSelector } from "../../storeSelectors";
import { useUiStateStore } from "../../uiStateStore";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { buildSubagentForest, childRefsOf } from "./SidebarSubagentTree.logic";

interface SidebarSubagentTreeProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}

function subagentStatusPill(
  status: OrchestrationSubagentRef["status"],
): "running" | "error" | "idle" {
  if (status === "inProgress") return "running";
  if (status === "failed" || status === "declined") return "error";
  return "idle";
}

export function SidebarSubagentTree({ environmentId, threadId }: SidebarSubagentTreeProps) {
  const refs = useStore(
    useMemo(() => createSubagentRefsSelector(environmentId, threadId), [environmentId, threadId]),
  );
  const threadKey = useMemo(
    () => scopedThreadKey(scopeThreadRef(environmentId, threadId)),
    [environmentId, threadId],
  );
  const forest = useMemo(() => buildSubagentForest(refs), [refs]);

  if (refs.length === 0) {
    return null;
  }

  if (forest.kind === "grouped") {
    return (
      <SidebarMenuSub className="mr-0">
        {forest.groups.map((group) => (
          <SubagentIterationNode
            key={`${threadKey}::iter::${group.iteration}`}
            environmentId={environmentId}
            threadId={threadId}
            threadKey={threadKey}
            iteration={group.iteration}
            groupRefs={group.refs}
            allRefs={refs}
          />
        ))}
      </SidebarMenuSub>
    );
  }

  return (
    <SidebarMenuSub className="mr-0">
      {forest.refs.map((ref) => (
        <SubagentNode
          key={`${threadKey}::sa::${ref.rootItemId}`}
          environmentId={environmentId}
          threadId={threadId}
          threadKey={threadKey}
          subagentRef={ref}
          allRefs={refs}
        />
      ))}
    </SidebarMenuSub>
  );
}

function SubagentIterationNode({
  environmentId,
  threadId,
  threadKey,
  iteration,
  groupRefs,
  allRefs,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadKey: string;
  iteration: number;
  groupRefs: OrchestrationSubagentRef[];
  allRefs: OrchestrationSubagentRef[];
}) {
  const key = `${threadKey}::iter::${iteration}`;
  const expanded = useUiStateStore((state) => state.subagentExpandedById[key] ?? false);
  const toggleSubagent = useUiStateStore((state) => state.toggleSubagent);

  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        size="sm"
        data-testid={`subagent-iteration-${threadId}-${iteration}`}
        className="cursor-pointer"
        onClick={() => toggleSubagent(key)}
      >
        <ChevronRightIcon
          className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/80">
          Iteration {iteration}
        </span>
      </SidebarMenuSubButton>
      {expanded && (
        <SidebarMenuSub className="mr-0">
          {groupRefs.map((ref) => (
            <SubagentNode
              key={`${threadKey}::sa::${ref.rootItemId}`}
              environmentId={environmentId}
              threadId={threadId}
              threadKey={threadKey}
              subagentRef={ref}
              allRefs={allRefs}
            />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuSubItem>
  );
}

function SubagentNode({
  environmentId,
  threadId,
  threadKey,
  subagentRef,
  allRefs,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadKey: string;
  subagentRef: OrchestrationSubagentRef;
  allRefs: OrchestrationSubagentRef[];
}) {
  const navigate = useNavigate();
  const key = `${threadKey}::sa::${subagentRef.rootItemId}`;
  const expanded = useUiStateStore((state) => state.subagentExpandedById[key] ?? false);
  const toggleSubagent = useUiStateStore((state) => state.toggleSubagent);
  const children = useMemo(
    () => childRefsOf(allRefs, subagentRef.rootItemId),
    [allRefs, subagentRef.rootItemId],
  );
  const hasChildren = subagentRef.childSubagentCount > 0 || children.length > 0;
  const statusPill = subagentStatusPill(subagentRef.status);

  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        size="sm"
        data-testid={`subagent-row-${subagentRef.rootItemId}`}
        className="cursor-pointer"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId/subagent/$subagentRootItemId",
            params: {
              environmentId,
              threadId,
              subagentRootItemId: subagentRef.rootItemId,
            },
          })
        }
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse subagent" : "Expand subagent"}
            className="inline-flex cursor-pointer items-center justify-center outline-hidden"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleSubagent(key);
            }}
          >
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </button>
        ) : (
          <span className="-ml-0.5 size-3.5 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {statusPill !== "idle" && <ThreadStatusLabel status={statusPill} />}
          <span className="min-w-0 flex-1 truncate text-xs">{subagentRef.subagentType}</span>
          {subagentRef.description && (
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/55">
              {subagentRef.description}
            </span>
          )}
        </span>
      </SidebarMenuSubButton>
      {expanded && hasChildren && (
        <SidebarMenuSub className="mr-0">
          {children.map((child) => (
            <SubagentNode
              key={`${threadKey}::sa::${child.rootItemId}`}
              environmentId={environmentId}
              threadId={threadId}
              threadKey={threadKey}
              subagentRef={child}
              allRefs={allRefs}
            />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuSubItem>
  );
}
```

> NOTE: `ThreadStatusLabel`'s `status` prop type is `ThreadStatusPill` (from `./Sidebar.logic`). Confirm `"running" | "error" | "idle"` are valid members; if the union differs (e.g. uses `"failed"`), map `subagentStatusPill` to the actual members. If no exact match exists, fall back to a plain status dot (`<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />` for non-running, `animate-pulse` for running) rather than misusing `ThreadStatusLabel`.

- [ ] **Step 4**: Wire the chevron + tree into `SidebarThreadRow` in `Sidebar.tsx`.

(a) Import the tree at the top with the other sidebar imports:

```ts
import { SidebarSubagentTree } from "./sidebar/SidebarSubagentTree";
```

(b) Inside `SidebarThreadRow`, read the session expand flag and the toggle, and retain the tree subscription when expanded. Add near the top of the component body (alongside the other hooks):

```ts
const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
const subagentExpanded = useUiStateStore((state) => state.subagentExpandedById[threadKey] ?? false);
const toggleSubagent = useUiStateStore((state) => state.toggleSubagent);

useEffect(() => {
  if (!thread.hasSubagents || !subagentExpanded) {
    return;
  }
  return retainSubagentTreeSubscription(thread.environmentId, thread.id);
}, [thread.environmentId, thread.id, thread.hasSubagents, subagentExpanded]);
```

(`threadKey` may already be computed in the row via `scopedThreadKey(...)`; if so reuse it and do not redeclare.) Import `retainSubagentTreeSubscription` alongside the existing `retainThreadDetailSubscription` import (`../environments/runtime/service`):

```ts
import {
  retainSubagentTreeSubscription,
  retainThreadDetailSubscription,
} from "../environments/runtime/service";
```

(c) Render the chevron at the start of the row content (inside the `<div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">`, before `prStatus`), gated on `thread.hasSubagents`:

```tsx
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {thread.hasSubagents && (
          <button
            type="button"
            aria-label={subagentExpanded ? "Collapse subagents" : "Expand subagents"}
            data-testid={`thread-subagent-toggle-${thread.id}`}
            className="inline-flex cursor-pointer items-center justify-center outline-hidden"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleSubagent(threadKey);
            }}
          >
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                subagentExpanded ? "rotate-90" : ""
              }`}
            />
          </button>
        )}
        {prStatus && (
```

(`ChevronRightIcon` is already imported in `Sidebar.tsx`.)

(d) Render the tree INSIDE the row's `SidebarMenuSubItem`, AFTER the closing `</SidebarMenuSubButton>`, gated on `subagentExpanded && thread.hasSubagents`. The current row return ends:

```tsx
      </div>
    </SidebarMenuSubButton>
  </SidebarMenuSubItem>
);
```

Change to:

```tsx
      </div>
    </SidebarMenuSubButton>
    {subagentExpanded && thread.hasSubagents && (
      <SidebarSubagentTree environmentId={thread.environmentId} threadId={thread.id} />
    )}
  </SidebarMenuSubItem>
);
```

- [ ] **Step 5**: Typecheck + lint + run the logic test:

```
cd apps/web && npx tsgo --noEmit
cd /home/chaz/projects/t3code && pnpm lint
pnpm --filter @t3tools/web test SidebarSubagentTree.logic
```

Expected: no type errors, lint clean, test PASS.

- [ ] **Step 6** (Commit):

```
git add apps/web/src/components/sidebar/SidebarSubagentTree.tsx apps/web/src/components/sidebar/SidebarSubagentTree.logic.ts apps/web/src/components/sidebar/SidebarSubagentTree.logic.test.ts apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): sidebar chevron + recursive subagent tree with iteration grouping"
```

---

## Task 7: Watch route + `SubagentWatchView`

**Files:**

- Create: `apps/web/src/components/SubagentWatchView.tsx`
- Create: `apps/web/src/routes/_chat.$environmentId.$threadId.subagent.$subagentRootItemId.tsx`
- Modify: `apps/web/src/routeTree.gen.ts` (regenerated automatically — see note)
- Test: `apps/web/src/components/SubagentWatchView.test.tsx`

**Rationale for a dedicated view (not a `readOnly` prop on `ChatView`):** `ChatView` is ~5000 lines and its composer JSX (~4913-4925) is rendered unconditionally; threading a `readOnly` flag through it would be invasive and risky. The watch view only needs: (1) the activities subscription, (2) the timeline derivation (`deriveWorkLogEntries` → `deriveTimelineEntries`), (3) `<MessagesTimeline>` with no composer, (4) a finished banner. A small standalone component is far cleaner and isolates the read-only path.

### Steps

- [ ] **Step 1** (test first): Create `apps/web/src/components/SubagentWatchView.test.tsx`. Mirror `MessagesTimeline.test.tsx` setup (it mocks `@legendapp/list/react` and `@pierre/diffs/react`, stubs `localStorage`/`window`/`document` in `beforeAll`, imports from `vite-plus/test`). Mock the subscription so retaining is a no-op, seed the store with subagent activities + a ref, render, and assert: (a) the timeline renders the activity, (b) NO composer/textarea is present, (c) the finished banner shows when the ref status is `completed`.

```tsx
import { EnvironmentId, ThreadId, EventId } from "@t3tools/contracts";
import type { OrchestrationSubagentRef, OrchestrationThreadActivity } from "@t3tools/contracts";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

vi.mock("@legendapp/list/react", async () => {
  /* copy the LegendList mock from MessagesTimeline.test.tsx */
  // ...
  return { LegendList: () => null };
});
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));
vi.mock("../environments/runtime/service", () => ({
  retainSubagentActivitiesSubscription: vi.fn(() => () => undefined),
}));

beforeAll(() => {
  // copy the localStorage/window/document stubs from MessagesTimeline.test.tsx
});

import { SubagentWatchView } from "./SubagentWatchView";
import { useStore } from "../store";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const rootItemId = "root-1";

function makeRef(status: OrchestrationSubagentRef["status"]): OrchestrationSubagentRef {
  return {
    threadId,
    rootItemId,
    parentItemId: null,
    label: "code-reviewer: review",
    subagentType: "code-reviewer",
    description: "review",
    status,
    iteration: null,
    turnId: null,
    depth: 0,
    childSubagentCount: 0,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function makeActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.make("act-1"),
    tone: "info",
    kind: "tool.completed",
    summary: "Subagent message",
    payload: { itemType: "assistant_message", status: "completed", detail: "Reviewed." },
    turnId: null,
    createdAt: "2026-06-20T00:00:00.000Z",
  };
}

describe("SubagentWatchView", () => {
  it("renders the subagent transcript without a composer", () => {
    useStore.setState(
      (state) =>
        useStore
          .getState()
          .syncSubagentActivitiesSnapshot(environmentId, threadId, rootItemId, [makeActivity()]) ??
        state,
    );
    // Simpler: call the reducer-backed action directly:
    useStore
      .getState()
      .syncSubagentActivitiesSnapshot(environmentId, threadId, rootItemId, [makeActivity()]);
    useStore.getState().syncSubagentTreeSnapshot(environmentId, threadId, [makeRef("inProgress")]);

    render(
      <SubagentWatchView
        environmentId={environmentId}
        threadId={threadId}
        subagentRootItemId={rootItemId}
      />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("subagent-finished-banner")).toBeNull();
  });

  it("shows the finished banner when the ref status leaves inProgress", () => {
    useStore.getState().syncSubagentTreeSnapshot(environmentId, threadId, [makeRef("completed")]);
    render(
      <SubagentWatchView
        environmentId={environmentId}
        threadId={threadId}
        subagentRootItemId={rootItemId}
      />,
    );
    expect(screen.getByTestId("subagent-finished-banner")).toBeDefined();
  });
});
```

> If `@testing-library/react` is not already a dev dependency, check `MessagesTimeline.test.tsx` — it uses `renderToStaticMarkup` instead. Mirror whichever the repo uses; the existing timeline test uses `react-dom/server`'s `renderToStaticMarkup`, so prefer that to avoid adding deps: render `renderToStaticMarkup(<SubagentWatchView .../>)` and assert on the returned HTML string (`expect(html).not.toContain("textarea")`, `expect(html).toContain("Subagent finished")`). Adjust assertions accordingly.

Run; confirm FAIL (module missing):

```
pnpm --filter @t3tools/web test SubagentWatchView
```

Expected: FAIL.

- [ ] **Step 2**: Create `apps/web/src/components/SubagentWatchView.tsx`. It retains the activities subscription, reads activities + the ref via selectors, derives the timeline, and renders `<MessagesTimeline>` with no composer plus a finished banner.

```tsx
import { createRef, useEffect, useMemo } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";

import { useStore } from "../store";
import { createSubagentActivitiesSelector, createSubagentRefsSelector } from "../storeSelectors";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../session-logic";
import { retainSubagentActivitiesSubscription } from "../environments/runtime/service";
import { MessagesTimeline } from "./chat/MessagesTimeline";

const EMPTY_MESSAGES: never[] = [];
const EMPTY_PLANS: never[] = [];
const NOOP = () => undefined;

interface SubagentWatchViewProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  subagentRootItemId: string;
}

export function SubagentWatchView({
  environmentId,
  threadId,
  subagentRootItemId,
}: SubagentWatchViewProps) {
  const listRef = useMemo(() => createRef<LegendListRef | null>(), []);

  useEffect(
    () => retainSubagentActivitiesSubscription(environmentId, threadId, subagentRootItemId),
    [environmentId, threadId, subagentRootItemId],
  );

  const activities = useStore(
    useMemo(
      () => createSubagentActivitiesSelector(environmentId, threadId, subagentRootItemId),
      [environmentId, threadId, subagentRootItemId],
    ),
  );
  const refs = useStore(
    useMemo(() => createSubagentRefsSelector(environmentId, threadId), [environmentId, threadId]),
  );
  const subagentRef = useMemo(
    () => refs.find((ref) => ref.rootItemId === subagentRootItemId) ?? null,
    [refs, subagentRootItemId],
  );

  const workLogEntries = useMemo(() => deriveWorkLogEntries(activities), [activities]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(EMPTY_MESSAGES, EMPTY_PLANS, workLogEntries),
    [workLogEntries],
  );

  const routeThreadKey = useMemo(
    () => scopedThreadKey(scopeThreadRef(environmentId, threadId)),
    [environmentId, threadId],
  );

  const isFinished = subagentRef !== null && subagentRef.status !== "inProgress";
  const subagentType = subagentRef?.subagentType ?? "Subagent";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <span className="text-sm font-medium text-foreground/80">Subagent: {subagentType}</span>
        {subagentRef?.description && (
          <span className="truncate text-xs text-muted-foreground/60">
            {subagentRef.description}
          </span>
        )}
      </div>
      {isFinished && (
        <div
          data-testid="subagent-finished-banner"
          className="border-b border-border/60 bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground/80"
        >
          Subagent finished
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <MessagesTimeline
          isWorking={!isFinished}
          activeTurnInProgress={!isFinished}
          activeTurnStartedAt={null}
          listRef={listRef}
          timelineEntries={timelineEntries}
          latestTurn={null}
          turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFF_SUMMARIES}
          routeThreadKey={routeThreadKey}
          onOpenTurnDiff={NOOP}
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
          onRevertUserMessage={NOOP}
          isRevertingCheckpoint={false}
          onImageExpand={NOOP}
          activeThreadEnvironmentId={environmentId}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="relative"
          workspaceRoot={undefined}
          onIsAtEndChange={NOOP}
        />
      </div>
    </div>
  );
}

const EMPTY_TURN_DIFF_SUMMARIES = new Map();
const EMPTY_REVERT_COUNTS = new Map();
```

> IMPORTANT — match `MessagesTimelineProps` exactly (apps/web/src/components/chat/MessagesTimeline.tsx ~149-170). The props passed above cover every required field: `isWorking`, `activeTurnInProgress`, `activeTurnStartedAt`, `listRef`, `timelineEntries`, `latestTurn`, `turnDiffSummaryByAssistantMessageId`, `routeThreadKey`, `onOpenTurnDiff`, `revertTurnCountByUserMessageId`, `onRevertUserMessage`, `isRevertingCheckpoint`, `onImageExpand`, `activeThreadEnvironmentId`, `markdownCwd`, `resolvedTheme`, `timestampFormat`, `workspaceRoot`, `onIsAtEndChange`. `skills` is optional (defaults to `EMPTY_TIMELINE_SKILLS`) so it is omitted. For `resolvedTheme` and `timestampFormat`, read the real app values if a theme/settings hook is cheaply available (e.g. `useSettings()` used in `ChatView`); otherwise the literals above are acceptable for v1. If typecheck rejects a literal (e.g. `timestampFormat` is a stricter union), import the type from `@t3tools/contracts/settings` and use a valid member.

- [ ] **Step 3**: Re-run the test; confirm PASS:

```
pnpm --filter @t3tools/web test SubagentWatchView
```

Expected: PASS.

- [ ] **Step 4**: Create the route file `apps/web/src/routes/_chat.$environmentId.$threadId.subagent.$subagentRootItemId.tsx`. Mirror the structure of `_chat.$environmentId.$threadId.tsx` but simpler (no draft/search handling). Wrap in `<SidebarInset>`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { SubagentWatchView } from "../components/SubagentWatchView";
import { SidebarInset } from "~/components/ui/sidebar";

function SubagentWatchRouteView() {
  const { environmentId, threadId, subagentRootItemId } = Route.useParams();
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <SubagentWatchView
        environmentId={EnvironmentId.make(environmentId)}
        threadId={ThreadId.make(threadId)}
        subagentRootItemId={subagentRootItemId}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute(
  "/_chat/$environmentId/$threadId/subagent/$subagentRootItemId",
)({
  component: SubagentWatchRouteView,
});
```

> `Route.useParams()` returns `environmentId`, `threadId`, `subagentRootItemId` as strings; brand them with `EnvironmentId.make` / `ThreadId.make`. Confirm how sibling routes brand params — `_chat.$environmentId.$threadId.tsx` uses `resolveThreadRouteRef(params)` (in `../threadRoutes`) which does the branding; if a shared helper exists, prefer it. If `resolveThreadRouteRef` returns the env+thread ref, you can reuse it and only brand the extra `subagentRootItemId` string directly.

- [ ] **Step 5**: Regenerate the route tree. The web app uses `@tanstack/router-plugin/vite` (`tanstackRouter` in `apps/web/vite.config.ts`), so `routeTree.gen.ts` is regenerated automatically by the Vite plugin when the dev server runs. Generate it by starting the dev server briefly, or run the typecheck which will fail until the tree is regenerated. Easiest: run the dev server once so the plugin writes the new route, then stop it:

```
pnpm --filter @t3tools/web dev
```

(Let it boot, confirm `apps/web/src/routeTree.gen.ts` now references `subagent/$subagentRootItemId`, then Ctrl-C.) If the plugin exposes a standalone generate command in this repo, prefer it; otherwise the dev-server boot is the supported path. Commit the regenerated `routeTree.gen.ts`.

- [ ] **Step 6**: Typecheck + lint:

```
cd apps/web && npx tsgo --noEmit
cd /home/chaz/projects/t3code && pnpm lint
```

Expected: no errors (route params typed via the generated tree; `SubagentWatchView` props match `MessagesTimelineProps`).

- [ ] **Step 7** (Commit):

```
git add apps/web/src/components/SubagentWatchView.tsx apps/web/src/components/SubagentWatchView.test.tsx apps/web/src/routes/_chat.$environmentId.$threadId.subagent.$subagentRootItemId.tsx apps/web/src/routeTree.gen.ts
git commit -m "feat(web): add read-only subagent watch route and SubagentWatchView"
```

---

## Task 8: Replace inline `SubagentCard` with `SubagentRefChip`

**Files:**

- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx` (replace the `<SubagentCard>` return in `WorkGroupSection` ~918-945 with a `<SubagentRefChip>`; `SubagentRefChip` lives in this same file; remove/retire `SubagentCard` if now unused; `parseSubagentLabel` ~738-744 is reused)
- Test: `apps/web/src/components/chat/MessagesTimeline.test.tsx` (add a chip test; update any existing `SubagentCard` assertions); `apps/web/src/session-logic.test.ts` (the subagent-nesting test at ~786-808 still holds — the derivation is unchanged — but after Phase 1 the parent thread has no children, so update any test that asserted inline child rows render in the timeline)

The chip is a single navigable row showing `Subagent: <type>` + status + an "open" affordance, linking to the watch route. Because Phase 1 removed subagent-child activities from the parent thread, there are no child entries to render inline anyway — the chip is purely a navigation affordance.

### Steps

- [ ] **Step 1** (test first): Add a test to `apps/web/src/components/chat/MessagesTimeline.test.tsx` that a `collab_agent_tool_call` work entry renders a `SubagentRefChip` (not a transcript) and that it links to the watch route. The component currently has no `useNavigate`; the chip will use it, so the test must mock `@tanstack/react-router`'s `useNavigate` (mirror how other component tests mock router) and assert it was called with the correct `subagentRootItemId` on click, OR render and assert the chip text + a `data-testid`. Since the existing test uses `renderToStaticMarkup` (no events), assert on static output:

```tsx
// In MessagesTimeline.test.tsx, add a timelineEntries fixture with a work entry:
//   { id, kind: "work", createdAt, entry: { itemType: "collab_agent_tool_call",
//     toolItemId: "root-1", label: "code-reviewer: review the diff",
//     toolLifecycleStatus: "inProgress", tone: "tool", ... } }
// Then:
it("renders a subagent ref chip for a collab_agent_tool_call entry", () => {
  const html = renderToStaticMarkup(<MessagesTimeline {...buildPropsWithSubagentEntry()} />);
  expect(html).toContain("Subagent:");
  expect(html).toContain("code-reviewer");
  // No inline transcript / child rows:
  expect(html).not.toContain("running..."); // old card affordance
});
```

If the static-markup approach can't reach the chip's link target, prefer an interactive render + `useNavigate` mock and assert the navigate call. Run; confirm FAIL:

```
pnpm --filter @t3tools/web test MessagesTimeline.test
```

Expected: FAIL.

- [ ] **Step 2**: Add `useNavigate` + the route params type import at the top of `MessagesTimeline.tsx`. The file imports `parseScopedThreadKey` from `@t3tools/client-runtime`; add a router import:

```ts
import { useNavigate } from "@tanstack/react-router";
```

The chip needs `environmentId` + `threadId` to navigate. `MessagesTimelineProps` already carries `activeThreadEnvironmentId` and `routeThreadKey` (a scoped thread key parseable via `parseScopedThreadKey`). `WorkGroupSection` is an inner component — thread it the env + thread id. The cleanest path: parse the route thread key once at the top of `MessagesTimeline` and pass `environmentId` + `threadId` down to `WorkGroupSection` (it already receives `workspaceRoot` via context/props). Confirm how `WorkGroupSection` gets its props; if it reads a context, add env/thread there, else add explicit props.

Add the chip component (place near `SubagentCard` ~750):

```tsx
function SubagentRefChip({
  parent,
  environmentId,
  threadId,
}: {
  parent: TimelineWorkEntry;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const { type: subagentType, description } = parseSubagentLabel(parent.label);
  const isRunning = isInProgressSubagentParent(parent);
  const rootItemId = parent.toolItemId ?? "";

  return (
    <button
      type="button"
      data-testid={`subagent-ref-chip-${rootItemId}`}
      className="flex w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-left hover:bg-muted/40"
      disabled={rootItemId.length === 0}
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId/subagent/$subagentRootItemId",
          params: { environmentId, threadId, subagentRootItemId: rootItemId },
        })
      }
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]">
        <span className="font-semibold text-foreground/70">Subagent:</span>
        <span className="font-medium text-foreground/82 truncate">{subagentType}</span>
        {description && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{description}</span>
        )}
      </span>
      {isRunning ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/70">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
          <span>running</span>
        </span>
      ) : null}
      <span className="shrink-0 text-[11px] text-muted-foreground/55">open ↗</span>
    </button>
  );
}
```

Add `EnvironmentId`, `ThreadId` to the `@t3tools/contracts` import if not present (the file already imports `EnvironmentId`; add `ThreadId`).

- [ ] **Step 3**: Replace the `<SubagentCard>` return in `WorkGroupSection` (~918-945). The current branch is:

```tsx
        {topLevelEntries.map((workEntry) => {
          const isSubagentParent = workEntry.itemType === "collab_agent_tool_call";
          const children = allChildrenByParent.get(workEntry.toolItemId ?? "") ?? [];
          if (isSubagentParent) {
            return (
              <SubagentCard
                key={workEntry.id}
                parent={workEntry}
                childEntries={children}
                workspaceRoot={workspaceRoot}
              />
            );
          }
```

Replace the `if (isSubagentParent)` block with the chip (and remove the now-unused `children` for that branch — note `children` is still used by the non-subagent branch below, so keep the declaration):

```tsx
        {topLevelEntries.map((workEntry) => {
          const isSubagentParent = workEntry.itemType === "collab_agent_tool_call";
          const children = allChildrenByParent.get(workEntry.toolItemId ?? "") ?? [];
          if (isSubagentParent) {
            return (
              <SubagentRefChip
                key={workEntry.id}
                parent={workEntry}
                environmentId={environmentId}
                threadId={threadId}
              />
            );
          }
```

Thread `environmentId` and `threadId` into `WorkGroupSection`'s props (derive them in `MessagesTimeline` via `parseScopedThreadKey(routeThreadKey)` for the threadId and `activeThreadEnvironmentId` for the env, then pass down). Verify the exact `WorkGroupSection` prop wiring when implementing.

- [ ] **Step 4**: Remove the now-dead `SubagentCard` component (and its helper `isInProgressSubagentParent` only if no longer referenced — the chip still uses it, so keep it). If `SimpleWorkEntryRow` was used only by `SubagentCard`, it is still used by the non-subagent branch, so keep it. Confirm with a grep that `SubagentCard` has no remaining references before deleting.

- [ ] **Step 5**: Update affected tests. The `session-logic.test.ts` subagent test at ~786-808 (`keeps a subagent text child entry nested under its parent via parentItemId`) asserts on the **derivation** which is unchanged — leave it. Any `MessagesTimeline.test.tsx` assertion that expected an inline subagent transcript card (child rows, "running...") must be updated to expect the chip instead. Run the full timeline + session-logic suites:

```
pnpm --filter @t3tools/web test MessagesTimeline.test
pnpm --filter @t3tools/web test session-logic.test
```

Expected: PASS (after updating any stale card assertions).

- [ ] **Step 6**: Typecheck + lint:

```
cd apps/web && npx tsgo --noEmit
cd /home/chaz/projects/t3code && pnpm lint
```

Expected: no errors, lint clean.

- [ ] **Step 7** (Commit):

```
git add apps/web/src/components/chat/MessagesTimeline.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/session-logic.test.ts
git commit -m "feat(web): replace inline SubagentCard with a SubagentRefChip linking to the watch route"
```

---

## Phase 3 self-check

Run the full gates before declaring done:

- [ ] **Typecheck**: `cd apps/web && npx tsgo --noEmit` and `cd packages/client-runtime && npx tsgo --noEmit` — both clean.
- [ ] **Web unit suite**: `pnpm --filter @t3tools/web test` — all green (store, storeSelectors, service subscriptions, uiStateStore, SidebarSubagentTree.logic, SubagentWatchView, MessagesTimeline, session-logic).
- [ ] **Lint**: `pnpm lint` — clean.
- [ ] **`vp check`**: must pass (run from the relevant package / repo root per the repo convention) before the feature is considered done.
- [ ] **Manual smoke** (dev server, `pnpm --filter @t3tools/web dev`):
  1. Open a running session that has subagents → its sidebar row shows a chevron.
  2. Expand it → `subscribeSubagentTree` fires; subagents render nested (grouped under `Iteration N` for an unattended run, directly otherwise); a subagent with children shows its own chevron and nests recursively.
  3. Click a subagent → navigates to `/$environmentId/$threadId/subagent/$subagentRootItemId`; the read-only transcript streams live via `subscribeSubagent`; there is NO composer.
  4. Let the subagent finish → the "Subagent finished" banner appears and the transcript freezes (route stays valid because the data is persisted).
  5. In the parent thread timeline, a subagent appears as a compact `Subagent: <type> … open ↗` chip that navigates to the same watch route.

This completes the Subagent Session Tree feature (Phases 1 + 2 + 3). After this phase merges, subagents are first-class, watchable sessions: the parent thread snapshot is slim (no inline subagent transcripts), the sidebar tree loads refs lazily on expand, and each subagent's transcript loads one level at a time on watch.
