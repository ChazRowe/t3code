# Subagent Session Tree — Phase 2: Server Read APIs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two streaming WebSocket RPC read endpoints that let clients (Phase 3 web UI) load a thread's subagent structure and watch a single subagent's transcript without bloating the parent thread snapshot. `subscribeSubagentTree({ threadId })` streams a compact ref tree (refs only — ids, labels, status, `parentItemId`, `iteration`, `depth`, child counts) plus live status deltas while a session is expanded. `subscribeSubagent({ threadId, rootItemId })` streams one subagent's **direct child** activities (one level) plus live appends. Both mirror the existing `subscribeThread` pattern and are independently testable via server integration tests.

**Architecture:** The contract layer (`packages/contracts`) defines the new schemas, method-name constants, RPC-schema map entries, and `Rpc.make(..., { stream: true })` definitions. The server layer reads data through `ProjectionSnapshotQuery` (two new methods, `getSubagentTree` / `getSubagentActivities`, sourced from the Phase-1 `listSubagentRootRefRows` / `listSubagentChildActivityRows` row queries) and exposes the two handlers in `apps/server/src/ws.ts` following the exact `observeRpcStreamEffect` → `Effect.all` (snapshot + `getSnapshotSequence`) → `Option.isNone` guard → `streamDomainEvents.pipe(Stream.filter(...), Stream.map(...))` → `Stream.concat(snapshot, liveStream)` template used by `subscribeThread`/`subscribeShell`. Live deltas come from `thread.activity-appended` domain events filtered to the right subtree. No DB writes, no new tables — this phase is read-only.

**Tech Stack:** TypeScript, Effect (effect/Schema, effect/Stream, effect/unstable/rpc/Rpc), Vitest (`@effect/vitest`).

**Phase-1 dependencies (ASSUMED to already exist — do not re-implement):**

- `OrchestrationThreadActivity` (`packages/contracts/src/orchestration.ts` ~345) has optional top-level `itemId`, `parentItemId` (`Schema.NullOr(RuntimeItemId)` / `Schema.optional`), and `iteration` (`Schema.NullOr(PositiveInt)`).
- `ProjectionSnapshotQuery` exposes `listSubagentChildActivityRows({ threadId, parentItemId })` and `listSubagentRootRefRows({ threadId })` (row-level queries against `projection_thread_activities` using the Phase-1 `item_id` / `parent_item_id` / `iteration` columns).
- `getThreadDetailById`'s activity query already excludes `parent_item_id IS NOT NULL` (subagent transcripts are off the parent snapshot).

If a Phase-1 symbol is missing when you start a task, STOP and confirm Phase 1 is merged before proceeding — do not stub it here.

---

## Task 1: Contract schemas, method constants, RPC entries

**Files:**

- Modify: `packages/contracts/src/orchestration.ts` (imports ~9–24; `ORCHESTRATION_WS_METHODS` ~26–34; new schemas after `OrchestrationThreadStreamItem` ~1280; `OrchestrationRpcSchemas` ~1376–1405)
- Modify: `packages/contracts/src/rpc.ts` (after `WsOrchestrationSubscribeThreadRpc` ~644; `WsRpcGroup.make(...)` arg list ~748–749)
- Test: `packages/contracts/src/orchestration.test.ts`

1. - [ ] **Step 1 — Add the import for `RuntimeItemId`.** Open `packages/contracts/src/orchestration.ts`. The base-schema import block (lines ~9–24) currently imports from `./baseSchemas.ts`. Add `RuntimeItemId` to that list (alphabetical-ish, next to `ProviderItemId`):

   Find:

   ```ts
   import {
     ApprovalRequestId,
     CheckpointRef,
     CommandId,
     EventId,
     IsoDateTime,
     MessageId,
     NonNegativeInt,
     PositiveInt,
     ProjectId,
     ProviderItemId,
     ThreadId,
     TrimmedNonEmptyString,
     TurnId,
   } from "./baseSchemas.ts";
   ```

   Replace with (adds `RuntimeItemId`):

   ```ts
   import {
     ApprovalRequestId,
     CheckpointRef,
     CommandId,
     EventId,
     IsoDateTime,
     MessageId,
     NonNegativeInt,
     PositiveInt,
     ProjectId,
     ProviderItemId,
     RuntimeItemId,
     ThreadId,
     TrimmedNonEmptyString,
     TurnId,
   } from "./baseSchemas.ts";
   ```

   (`RuntimeItemId` is defined at `packages/contracts/src/baseSchemas.ts:51` — `export const RuntimeItemId = makeEntityId("RuntimeItemId");`)

2. - [ ] **Step 2 — Add the two method-name constants.** Find `ORCHESTRATION_WS_METHODS` (lines ~26–34):

   ```ts
   export const ORCHESTRATION_WS_METHODS = {
     dispatchCommand: "orchestration.dispatchCommand",
     getTurnDiff: "orchestration.getTurnDiff",
     getFullThreadDiff: "orchestration.getFullThreadDiff",
     replayEvents: "orchestration.replayEvents",
     getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
     subscribeShell: "orchestration.subscribeShell",
     subscribeThread: "orchestration.subscribeThread",
   } as const;
   ```

   Replace with:

   ```ts
   export const ORCHESTRATION_WS_METHODS = {
     dispatchCommand: "orchestration.dispatchCommand",
     getTurnDiff: "orchestration.getTurnDiff",
     getFullThreadDiff: "orchestration.getFullThreadDiff",
     replayEvents: "orchestration.replayEvents",
     getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
     subscribeShell: "orchestration.subscribeShell",
     subscribeThread: "orchestration.subscribeThread",
     subscribeSubagentTree: "orchestration.subscribeSubagentTree",
     subscribeSubagent: "orchestration.subscribeSubagent",
   } as const;
   ```

3. - [ ] **Step 3 — Add the new schemas.** Insert the following block immediately AFTER `OrchestrationThreadStreamItem` / its `export type` (line ~1280, right before `export const OrchestrationCommandReceiptStatus`). These are the LOCKED CONTRACT shapes:

   ```ts
   export const OrchestrationSubagentStatus = Schema.Literals([
     "inProgress",
     "completed",
     "failed",
     "declined",
   ]);
   export type OrchestrationSubagentStatus = typeof OrchestrationSubagentStatus.Type;

   export const OrchestrationSubagentRef = Schema.Struct({
     threadId: ThreadId,
     rootItemId: RuntimeItemId,
     parentItemId: Schema.NullOr(RuntimeItemId),
     label: TrimmedNonEmptyString,
     subagentType: TrimmedNonEmptyString,
     description: Schema.NullOr(TrimmedNonEmptyString),
     status: OrchestrationSubagentStatus,
     iteration: Schema.NullOr(PositiveInt),
     turnId: Schema.NullOr(TurnId),
     depth: NonNegativeInt,
     childSubagentCount: NonNegativeInt,
     createdAt: IsoDateTime,
     updatedAt: IsoDateTime,
   });
   export type OrchestrationSubagentRef = typeof OrchestrationSubagentRef.Type;

   export const OrchestrationSubscribeSubagentTreeInput = Schema.Struct({
     threadId: ThreadId,
   });
   export type OrchestrationSubscribeSubagentTreeInput =
     typeof OrchestrationSubscribeSubagentTreeInput.Type;

   export const OrchestrationSubagentTreeSnapshot = Schema.Struct({
     snapshotSequence: NonNegativeInt,
     threadId: ThreadId,
     refs: Schema.Array(OrchestrationSubagentRef),
   });
   export type OrchestrationSubagentTreeSnapshot = typeof OrchestrationSubagentTreeSnapshot.Type;

   export const OrchestrationSubagentTreeStreamItem = Schema.Union([
     Schema.Struct({
       kind: Schema.Literal("snapshot"),
       snapshot: OrchestrationSubagentTreeSnapshot,
     }),
     Schema.Struct({
       kind: Schema.Literal("ref-changed"),
       ref: OrchestrationSubagentRef,
     }),
     Schema.Struct({
       kind: Schema.Literal("ref-removed"),
       threadId: ThreadId,
       rootItemId: RuntimeItemId,
     }),
   ]);
   export type OrchestrationSubagentTreeStreamItem =
     typeof OrchestrationSubagentTreeStreamItem.Type;

   export const OrchestrationSubscribeSubagentInput = Schema.Struct({
     threadId: ThreadId,
     rootItemId: RuntimeItemId,
   });
   export type OrchestrationSubscribeSubagentInput =
     typeof OrchestrationSubscribeSubagentInput.Type;

   export const OrchestrationSubagentActivitiesSnapshot = Schema.Struct({
     snapshotSequence: NonNegativeInt,
     threadId: ThreadId,
     rootItemId: RuntimeItemId,
     activities: Schema.Array(OrchestrationThreadActivity),
   });
   export type OrchestrationSubagentActivitiesSnapshot =
     typeof OrchestrationSubagentActivitiesSnapshot.Type;

   export const OrchestrationSubagentActivitiesStreamItem = Schema.Union([
     Schema.Struct({
       kind: Schema.Literal("snapshot"),
       snapshot: OrchestrationSubagentActivitiesSnapshot,
     }),
     Schema.Struct({
       kind: Schema.Literal("event"),
       event: OrchestrationEvent,
     }),
   ]);
   export type OrchestrationSubagentActivitiesStreamItem =
     typeof OrchestrationSubagentActivitiesStreamItem.Type;
   ```

   Note: `OrchestrationEvent` is defined at line ~1131–1268 (above the insertion point), and `OrchestrationThreadActivity` at ~345, so both are in scope. This mirrors `OrchestrationThreadStreamItem` (the snapshot/event union template, ~1270) and `OrchestrationShellStreamItem` (the multi-arm `kind`-discriminated union template, ~480) — `ref-changed`/`ref-removed` mirror `project-upserted`/`project-removed`.

4. - [ ] **Step 4 — Add `OrchestrationRpcSchemas` entries.** Find `OrchestrationRpcSchemas` (lines ~1376–1405) and add two entries before the closing `} as const;`:

   ```ts
     subscribeThread: {
       input: OrchestrationSubscribeThreadInput,
       output: OrchestrationThreadStreamItem,
     },
     subscribeShell: {
       input: Schema.Struct({}),
       output: OrchestrationShellStreamItem,
     },
   } as const;
   ```

   Replace with:

   ```ts
     subscribeThread: {
       input: OrchestrationSubscribeThreadInput,
       output: OrchestrationThreadStreamItem,
     },
     subscribeShell: {
       input: Schema.Struct({}),
       output: OrchestrationShellStreamItem,
     },
     subscribeSubagentTree: {
       input: OrchestrationSubscribeSubagentTreeInput,
       output: OrchestrationSubagentTreeStreamItem,
     },
     subscribeSubagent: {
       input: OrchestrationSubscribeSubagentInput,
       output: OrchestrationSubagentActivitiesStreamItem,
     },
   } as const;
   ```

5. - [ ] **Step 5 — Add `Rpc.make` stream definitions in `rpc.ts`.** Open `packages/contracts/src/rpc.ts`. The `OrchestrationGetSnapshotError`, `EnvironmentAuthorizationError`, `Rpc`, `Schema`, `ORCHESTRATION_WS_METHODS`, and `OrchestrationRpcSchemas` symbols are already imported (lines 1–2, 9, 54, and the `from "./orchestration.ts"` block). After `WsOrchestrationSubscribeThreadRpc` (ends line ~644), add:

   ```ts
   export const WsOrchestrationSubscribeSubagentTreeRpc = Rpc.make(
     ORCHESTRATION_WS_METHODS.subscribeSubagentTree,
     {
       payload: OrchestrationRpcSchemas.subscribeSubagentTree.input,
       success: OrchestrationRpcSchemas.subscribeSubagentTree.output,
       error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
       stream: true,
     },
   );

   export const WsOrchestrationSubscribeSubagentRpc = Rpc.make(
     ORCHESTRATION_WS_METHODS.subscribeSubagent,
     {
       payload: OrchestrationRpcSchemas.subscribeSubagent.input,
       success: OrchestrationRpcSchemas.subscribeSubagent.output,
       error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
       stream: true,
     },
   );
   ```

   This mirrors `WsOrchestrationSubscribeThreadRpc`/`WsOrchestrationSubscribeShellRpc` (~629–644). Confirm `OrchestrationRpcSchemas` is in the `./orchestration.ts` import block at the top of `rpc.ts` (search `OrchestrationRpcSchemas` in the imports; if absent, add it to that import block).

6. - [ ] **Step 6 — Register the two RPCs in `WsRpcGroup`.** In `packages/contracts/src/rpc.ts`, find the `RpcGroup.make(` call (~681) and its argument list. Find:

   ```ts
     WsOrchestrationSubscribeShellRpc,
     WsOrchestrationSubscribeThreadRpc,
   ```

   Replace with:

   ```ts
     WsOrchestrationSubscribeShellRpc,
     WsOrchestrationSubscribeThreadRpc,
     WsOrchestrationSubscribeSubagentTreeRpc,
     WsOrchestrationSubscribeSubagentRpc,
   ```

7. - [ ] **Step 7 — Write the contract test.** Open `packages/contracts/src/orchestration.test.ts`. At the top, extend the import from `./orchestration.ts` to include the new symbols:

   ```ts
   import {
     ORCHESTRATION_WS_METHODS,
     OrchestrationRpcSchemas,
     OrchestrationSubagentRef,
     OrchestrationSubagentTreeStreamItem,
     OrchestrationSubagentActivitiesStreamItem,
   } from "./orchestration.ts";
   ```

   (Add these names to the existing import block — do not create a second import statement; some may already be imported.)

   Then append these tests (use the file's existing `it`/`assert` + `Schema.decodeUnknownEffect` idiom — see the top of the file, ~lines 1–40):

   ```ts
   const decodeSubagentRef = Schema.decodeUnknownEffect(OrchestrationSubagentRef);
   const decodeSubagentTreeStreamItem = Schema.decodeUnknownEffect(
     OrchestrationSubagentTreeStreamItem,
   );
   const decodeSubagentActivitiesStreamItem = Schema.decodeUnknownEffect(
     OrchestrationSubagentActivitiesStreamItem,
   );

   it.effect("decodes an OrchestrationSubagentRef round-trip", () =>
     Effect.gen(function* () {
       const ref = yield* decodeSubagentRef({
         threadId: "thread-1",
         rootItemId: "item-root",
         parentItemId: null,
         label: "Explore: find the bug",
         subagentType: "Explore",
         description: "find the bug",
         status: "inProgress",
         iteration: null,
         turnId: "turn-1",
         depth: 0,
         childSubagentCount: 1,
         createdAt: "2026-06-20T00:00:00.000Z",
         updatedAt: "2026-06-20T00:00:01.000Z",
       });
       assert.equal(ref.rootItemId, "item-root");
       assert.equal(ref.status, "inProgress");
       assert.equal(ref.depth, 0);
       assert.equal(ref.childSubagentCount, 1);
     }),
   );

   it.effect("decodes each OrchestrationSubagentTreeStreamItem arm", () =>
     Effect.gen(function* () {
       const snapshot = yield* decodeSubagentTreeStreamItem({
         kind: "snapshot",
         snapshot: { snapshotSequence: 3, threadId: "thread-1", refs: [] },
       });
       assert.equal(snapshot.kind, "snapshot");
       const removed = yield* decodeSubagentTreeStreamItem({
         kind: "ref-removed",
         threadId: "thread-1",
         rootItemId: "item-root",
       });
       assert.equal(removed.kind, "ref-removed");
     }),
   );

   it.effect("decodes OrchestrationSubagentActivitiesStreamItem snapshot arm", () =>
     Effect.gen(function* () {
       const item = yield* decodeSubagentActivitiesStreamItem({
         kind: "snapshot",
         snapshot: {
           snapshotSequence: 2,
           threadId: "thread-1",
           rootItemId: "item-root",
           activities: [],
         },
       });
       assert.equal(item.kind, "snapshot");
     }),
   );

   it("registers both subagent methods in ORCHESTRATION_WS_METHODS and OrchestrationRpcSchemas", () => {
     assert.equal(
       ORCHESTRATION_WS_METHODS.subscribeSubagentTree,
       "orchestration.subscribeSubagentTree",
     );
     assert.equal(ORCHESTRATION_WS_METHODS.subscribeSubagent, "orchestration.subscribeSubagent");
     assert.equal("subscribeSubagentTree" in OrchestrationRpcSchemas, true);
     assert.equal("subscribeSubagent" in OrchestrationRpcSchemas, true);
   });
   ```

   Note: `it`, `assert`, `Effect`, and `Schema` are already imported at the top of the file.

8. - [ ] **Step 8 — Run the contract test (expect PASS).**

   ```
   pnpm --filter @t3tools/contracts test orchestration
   ```

   Expected: the new tests PASS. If a decode fails on `iteration`/`turnId`, re-check the `Schema.NullOr` wrappers match the LOCKED shape exactly.

9. - [ ] **Step 9 — Typecheck the contracts package (expect PASS).**

   ```
   cd packages/contracts && npx tsgo --noEmit
   ```

   Expected: no errors. (If `RuntimeItemId` is reported unused or missing, re-check Step 1.)

10. - [ ] **Step 10 — Commit.**
    ```
    git add packages/contracts/src/orchestration.ts packages/contracts/src/rpc.ts packages/contracts/src/orchestration.test.ts
    git commit -m "feat(contracts): add subagent tree + subagent-activities subscribe RPC contracts"
    ```

---

## Task 2: `getSubagentTree` in ProjectionSnapshotQuery

**Files:**

- Modify: `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts` (`ProjectionSnapshotQueryShape` interface ~56–160 — add method signature)
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (imports ~1–60; new helper + `getSubagentTree` impl before the final `return { ... } satisfies ProjectionSnapshotQueryShape` ~2045; add to returned object)
- Test: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`

1. - [ ] **Step 1 — Add the method signature to the shape interface.** Open `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`. After `getThreadDetailById` (the last member, ~157–159) and before the closing `}` of `ProjectionSnapshotQueryShape` (~160), add:

   ```ts
     /**
      * Read the compact subagent ref tree for a thread (refs only, no transcripts).
      */
     readonly getSubagentTree: (input: {
       readonly threadId: ThreadId;
     }) => Effect.Effect<ReadonlyArray<OrchestrationSubagentRef>, ProjectionRepositoryError>;
   ```

   At the top of that file, add `OrchestrationSubagentRef` to the existing `@t3tools/contracts` import (it sits alongside `ThreadId`, `OrchestrationThread`, etc. — search the import block and add `OrchestrationSubagentRef`).

2. - [ ] **Step 2 — Write the unit test FIRST (TDD).** Open `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`. Add a new test inside the existing `projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => { ... })` block. It seeds: one root `collab_agent_tool_call` activity (`item_id = 'item-root-a'`, `parent_item_id NULL`, `iteration 1`), one child activity under it, and one nested root `collab_agent_tool_call` whose `parent_item_id = 'item-root-a'` (depth 1). The activity-row columns are `activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at` plus the Phase-1 columns `item_id, parent_item_id, iteration` (confirm exact column names against the Phase-1 migration before running; adjust the INSERT column list if Phase 1 named them differently):

   ```ts
   it.effect("getSubagentTree builds refs with depth, child counts, and status", () =>
     Effect.gen(function* () {
       const snapshotQuery = yield* ProjectionSnapshotQuery;
       const sql = yield* SqlClient.SqlClient;

       yield* sql`DELETE FROM projection_thread_activities`;
       yield* sql`DELETE FROM projection_threads`;
       yield* sql`DELETE FROM projection_projects`;

       yield* sql`
         INSERT INTO projection_projects (
           project_id, title, workspace_root, default_model_selection_json,
           scripts_json, created_at, updated_at, deleted_at
         ) VALUES (
           'project-1', 'Project 1', '/tmp/project-1',
           '{"provider":"codex","model":"gpt-5-codex"}', '[]',
           '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
         )
       `;
       yield* sql`
         INSERT INTO projection_threads (
           thread_id, project_id, title, model_selection_json, runtime_mode,
           interaction_mode, branch, worktree_path, latest_turn_id,
           latest_user_message_at, pending_approval_count, pending_user_input_count,
           has_actionable_proposed_plan, created_at, updated_at, deleted_at
         ) VALUES (
           'thread-1', 'project-1', 'Thread 1',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
           '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
         )
       `;

       // Root subagent ref (depth 0): collab_agent_tool_call, parent_item_id NULL.
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-root-a', 'thread-1', 'turn-1', 'tool', 'tool.started',
           'Explore: find the bug',
           '{"itemType":"collab_agent_tool_call","itemId":"item-root-a","label":"Explore: find the bug"}',
           '2026-06-20T00:00:01.000Z', 'item-root-a', NULL, 1
         )
       `;
       // Latest lifecycle for root A → completed.
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-root-a-done', 'thread-1', 'turn-1', 'tool', 'tool.completed',
           'Explore: find the bug',
           '{"itemType":"collab_agent_tool_call","itemId":"item-root-a","label":"Explore: find the bug"}',
           '2026-06-20T00:00:05.000Z', 'item-root-a', NULL, 1
         )
       `;
       // A direct (non-subagent) child of root A.
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-child-1', 'thread-1', 'turn-1', 'tool', 'tool.completed',
           'Read file', '{"itemType":"command_execution","itemId":"item-child-1"}',
           '2026-06-20T00:00:02.000Z', 'item-child-1', 'item-root-a', 1
         )
       `;
       // Nested subagent ref (depth 1): parent_item_id = item-root-a.
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-root-b', 'thread-1', 'turn-1', 'tool', 'tool.started',
           'Plan: design the fix',
           '{"itemType":"collab_agent_tool_call","itemId":"item-root-b","label":"Plan: design the fix"}',
           '2026-06-20T00:00:03.000Z', 'item-root-b', 'item-root-a', 1
         )
       `;

       const refs = yield* snapshotQuery.getSubagentTree({ threadId: ThreadId.make("thread-1") });

       const byItem = new Map(refs.map((r) => [r.rootItemId, r]));
       const rootA = byItem.get("item-root-a");
       const rootB = byItem.get("item-root-b");
       assert.equal(refs.length, 2);

       assert.equal(rootA?.depth, 0);
       assert.equal(rootA?.parentItemId, null);
       assert.equal(rootA?.subagentType, "Explore");
       assert.equal(rootA?.description, "find the bug");
       assert.equal(rootA?.status, "completed");
       assert.equal(rootA?.iteration, 1);
       assert.equal(rootA?.childSubagentCount, 1);

       assert.equal(rootB?.depth, 1);
       assert.equal(rootB?.parentItemId, "item-root-a");
       assert.equal(rootB?.subagentType, "Plan");
       assert.equal(rootB?.description, "design the fix");
       assert.equal(rootB?.status, "inProgress");
       assert.equal(rootB?.childSubagentCount, 0);
     }),
   );
   ```

   Add `RuntimeItemId` to the `@t3tools/contracts` import at the top of the test file if you reference it; otherwise the string literals above decode through the row queries.

3. - [ ] **Step 3 — Run the test (expect FAIL — method not implemented).**

   ```
   pnpm --filter t3 test ProjectionSnapshotQuery
   ```

   Expected: FAIL with a TypeError/"getSubagentTree is not a function" or a typecheck error. This confirms the test exercises the new method.

4. - [ ] **Step 4 — Implement the server-side label parser + status helper.** Open `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`. Near the top-of-module helpers (after the `decode*`/row-schema declarations, before `makeProjectionSnapshotQuery`), add a module-level helper mirroring the client `parseSubagentLabel` (`apps/web/src/components/chat/MessagesTimeline.tsx:738`):

   ```ts
   const parseSubagentLabel = (
     label: string,
   ): { readonly type: string; readonly description: string | null } => {
     const colonIdx = label.indexOf(": ");
     if (colonIdx > 0) {
       return {
         type: label.slice(0, colonIdx).trim(),
         description: label.slice(colonIdx + 2).trim() || null,
       };
     }
     return { type: label.trim(), description: null };
   };

   const subagentStatusFromKind = (kind: string): OrchestrationSubagentStatus => {
     if (kind === "tool.completed") return "completed";
     if (kind === "tool.failed" || kind === "tool.errored") return "failed";
     if (kind === "tool.denied") return "declined";
     return "inProgress";
   };
   ```

   Add `OrchestrationSubagentRef` and `OrchestrationSubagentStatus` to the `@t3tools/contracts` import block at the top of this layer file.

   Implementation notes for the parser source: the root ref's display label is the activity `summary` (e.g. `"Explore: find the bug"`); the Phase-1 `listSubagentRootRefRows` row should already expose a `summary`/`label` field plus `kind`, `turnId`, `iteration`, `parentItemId`, `createdAt`. If `listSubagentRootRefRows` does not return `kind`/latest-status, derive status from the latest lifecycle activity for that `itemId` via `listSubagentChildActivityRows` (Step 5) — but prefer reading it directly from the root-ref row if available.

5. - [ ] **Step 5 — Implement `getSubagentTree`.** Add this just before the final `return { ... } satisfies ProjectionSnapshotQueryShape;` (~2045):

   ```ts
   const getSubagentTree: ProjectionSnapshotQueryShape["getSubagentTree"] = ({ threadId }) =>
     Effect.gen(function* () {
       const rootRows = yield* listSubagentRootRefRows({ threadId }).pipe(
         Effect.mapError(
           toPersistenceSqlOrDecodeError(
             "ProjectionSnapshotQuery.getSubagentTree:listRootRefs:query",
             "ProjectionSnapshotQuery.getSubagentTree:listRootRefs:decodeRows",
           ),
         ),
       );

       // childSubagentCount: number of root refs whose parentItemId === this ref's rootItemId.
       const childCountByItem = new Map<string, number>();
       for (const row of rootRows) {
         if (row.parentItemId !== null) {
           childCountByItem.set(
             row.parentItemId,
             (childCountByItem.get(row.parentItemId) ?? 0) + 1,
           );
         }
       }

       // depth: walk the parentItemId chain among the known root refs.
       const itemIds = new Set(rootRows.map((row) => row.itemId));
       const parentByItem = new Map(rootRows.map((row) => [row.itemId, row.parentItemId] as const));
       const depthOf = (itemId: string): number => {
         let depth = 0;
         let current = parentByItem.get(itemId) ?? null;
         const seen = new Set<string>([itemId]);
         while (current !== null && itemIds.has(current) && !seen.has(current)) {
           depth += 1;
           seen.add(current);
           current = parentByItem.get(current) ?? null;
         }
         return depth;
       };

       const refs = rootRows.map((row): OrchestrationSubagentRef => {
         const { type, description } = parseSubagentLabel(row.summary);
         return {
           threadId,
           rootItemId: RuntimeItemId.make(row.itemId),
           parentItemId: row.parentItemId === null ? null : RuntimeItemId.make(row.parentItemId),
           label: row.summary,
           subagentType: type,
           description,
           status: subagentStatusFromKind(row.kind),
           iteration: row.iteration,
           turnId: row.turnId,
           depth: depthOf(row.itemId),
           childSubagentCount: childCountByItem.get(row.itemId) ?? 0,
           createdAt: row.createdAt,
           updatedAt: row.updatedAt ?? row.createdAt,
         };
       });

       return refs;
     });
   ```

   IMPORTANT: this references the exact field names returned by the Phase-1 `listSubagentRootRefRows` row schema. Before running, open the Phase-1 row-schema definition and confirm the property names (`itemId`, `parentItemId`, `summary`, `kind`, `turnId`, `iteration`, `createdAt`). If Phase 1 returns the latest-status row only once per `itemId`, `subagentStatusFromKind(row.kind)` reflects the latest lifecycle. If the row exposes the label under a different key (e.g. `label` instead of `summary`), substitute it consistently in both the `label:` and `parseSubagentLabel(...)` lines. Use `TrimmedNonEmptyString.make(...)` if the contract decode rejects an untrimmed/empty `label`; in practice the activity `summary` is already `TrimmedNonEmptyString`.

6. - [ ] **Step 6 — Add `getSubagentTree` to the returned object.** In the final return object (~2045–2059), add `getSubagentTree,` after `getThreadDetailById,`:

   ```ts
     getThreadShellById,
     getThreadDetailById,
     getSubagentTree,
   } satisfies ProjectionSnapshotQueryShape;
   ```

7. - [ ] **Step 7 — Run the test (expect PASS).**

   ```
   pnpm --filter t3 test ProjectionSnapshotQuery
   ```

   Expected: PASS. If `depth` for `rootB` is `0` instead of `1`, verify the seeded `item_id`/`parent_item_id` columns and the `depthOf` chain. If `childSubagentCount` for `rootA` is `0`, verify `rootB.parentItemId === 'item-root-a'` in the seed.

8. - [ ] **Step 8 — Typecheck the server package (expect PASS).**

   ```
   cd apps/server && npx tsgo --noEmit
   ```

   Expected: no errors.

9. - [ ] **Step 9 — Commit.**
   ```
   git add apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts
   git commit -m "feat(server): add getSubagentTree projection query"
   ```

---

## Task 3: `getSubagentActivities` in ProjectionSnapshotQuery

**Files:**

- Modify: `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts` (`ProjectionSnapshotQueryShape` — add signature after `getSubagentTree`)
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (new impl + add to returned object)
- Test: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`

1. - [ ] **Step 1 — Add the signature to the shape interface.** In `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`, after the `getSubagentTree` signature (added in Task 2), add:

   ```ts
     /**
      * Read a single subagent's direct child activities (one level), ordered chronologically.
      */
     readonly getSubagentActivities: (input: {
       readonly threadId: ThreadId;
       readonly rootItemId: RuntimeItemId;
     }) => Effect.Effect<
       ReadonlyArray<OrchestrationThreadActivity>,
       ProjectionRepositoryError
     >;
   ```

   Add `RuntimeItemId` and `OrchestrationThreadActivity` to the `@t3tools/contracts` import in this file if not already present.

2. - [ ] **Step 2 — Write the unit test FIRST (TDD).** In `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`, add:

   ```ts
   it.effect("getSubagentActivities returns only the direct children of a subagent root", () =>
     Effect.gen(function* () {
       const snapshotQuery = yield* ProjectionSnapshotQuery;
       const sql = yield* SqlClient.SqlClient;

       yield* sql`DELETE FROM projection_thread_activities`;
       yield* sql`DELETE FROM projection_threads`;
       yield* sql`DELETE FROM projection_projects`;

       yield* sql`
         INSERT INTO projection_projects (
           project_id, title, workspace_root, default_model_selection_json,
           scripts_json, created_at, updated_at, deleted_at
         ) VALUES (
           'project-1', 'Project 1', '/tmp/project-1',
           '{"provider":"codex","model":"gpt-5-codex"}', '[]',
           '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
         )
       `;
       yield* sql`
         INSERT INTO projection_threads (
           thread_id, project_id, title, model_selection_json, runtime_mode,
           interaction_mode, branch, worktree_path, latest_turn_id,
           latest_user_message_at, pending_approval_count, pending_user_input_count,
           has_actionable_proposed_plan, created_at, updated_at, deleted_at
         ) VALUES (
           'thread-1', 'project-1', 'Thread 1',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
           '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
         )
       `;

       // Direct child of item-root-a (kept).
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-direct-1', 'thread-1', 'turn-1', 'tool', 'tool.completed',
           'Read file', '{"itemType":"command_execution","itemId":"item-direct-1"}',
           '2026-06-20T00:00:02.000Z', 'item-direct-1', 'item-root-a', 1
         )
       `;
       // Second direct child of item-root-a (kept).
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-direct-2', 'thread-1', 'turn-1', 'info', 'assistant.message',
           'Found it', '{"itemType":"assistant_message","itemId":"item-direct-2"}',
           '2026-06-20T00:00:03.000Z', 'item-direct-2', 'item-root-a', 1
         )
       `;
       // Grandchild (parent_item_id = item-direct-2) → excluded.
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-grandchild', 'thread-1', 'turn-1', 'tool', 'tool.completed',
           'Deep tool', '{"itemType":"command_execution","itemId":"item-deep"}',
           '2026-06-20T00:00:04.000Z', 'item-deep', 'item-direct-2', 1
         )
       `;

       const activities = yield* snapshotQuery.getSubagentActivities({
         threadId: ThreadId.make("thread-1"),
         rootItemId: RuntimeItemId.make("item-root-a"),
       });

       assert.deepEqual(
         activities.map((a) => a.id),
         ["act-direct-1", "act-direct-2"],
       );
       assert.equal(activities[0]?.summary, "Read file");
     }),
   );
   ```

   Ensure `RuntimeItemId` is imported from `@t3tools/contracts` at the top of the test file.

3. - [ ] **Step 3 — Run the test (expect FAIL — method not implemented).**

   ```
   pnpm --filter t3 test ProjectionSnapshotQuery
   ```

   Expected: FAIL ("getSubagentActivities is not a function" or typecheck error).

4. - [ ] **Step 4 — Implement `getSubagentActivities`.** In `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, add before the final return object (after `getSubagentTree`):

   ```ts
   const getSubagentActivities: ProjectionSnapshotQueryShape["getSubagentActivities"] = ({
     threadId,
     rootItemId,
   }) =>
     Effect.gen(function* () {
       const rows = yield* listSubagentChildActivityRows({
         threadId,
         parentItemId: rootItemId,
       }).pipe(
         Effect.mapError(
           toPersistenceSqlOrDecodeError(
             "ProjectionSnapshotQuery.getSubagentActivities:listChildren:query",
             "ProjectionSnapshotQuery.getSubagentActivities:listChildren:decodeRows",
           ),
         ),
       );

       return rows.map((row): OrchestrationThreadActivity => {
         const activity = {
           id: row.activityId,
           tone: row.tone,
           kind: row.kind,
           summary: row.summary,
           payload: row.payload,
           turnId: row.turnId,
           createdAt: row.createdAt,
         };
         const withItemFields = Object.assign(
           activity,
           row.parentItemId !== null ? { parentItemId: row.parentItemId } : {},
           row.itemId !== null ? { itemId: row.itemId } : {},
           row.iteration !== null ? { iteration: row.iteration } : {},
         );
         if (row.sequence !== null) {
           return Object.assign(withItemFields, { sequence: row.sequence });
         }
         return withItemFields;
       });
     });
   ```

   IMPORTANT: this maps the Phase-1 `listSubagentChildActivityRows` row to `OrchestrationThreadActivity` exactly the way `getThreadDetailById` maps activity rows (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:2008–2022`). Confirm the row's `itemId`/`parentItemId`/`iteration` property names against the Phase-1 row schema and adjust the `Object.assign` keys to match. The promoted top-level activity fields (`itemId`, `parentItemId`, `iteration`) are the Phase-1 additions to `OrchestrationThreadActivity`; if Phase 1 mapped these differently, mirror that mapping. If those fields are NOT yet on `OrchestrationThreadActivity`, drop the `withItemFields` assignment and return `activity` directly (the watch view only needs the activity body), but keep the test asserting `id`/`summary`.

5. - [ ] **Step 5 — Add `getSubagentActivities` to the returned object.** After `getSubagentTree,` in the return object:

   ```ts
     getSubagentTree,
     getSubagentActivities,
   } satisfies ProjectionSnapshotQueryShape;
   ```

6. - [ ] **Step 6 — Run the test (expect PASS).**

   ```
   pnpm --filter t3 test ProjectionSnapshotQuery
   ```

   Expected: PASS. If the grandchild row leaks in, verify `listSubagentChildActivityRows` filters on `parent_item_id = :parentItemId` (one level) — that is a Phase-1 query and should already be correct.

7. - [ ] **Step 7 — Typecheck (expect PASS).**

   ```
   cd apps/server && npx tsgo --noEmit
   ```

8. - [ ] **Step 8 — Commit.**
   ```
   git add apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts
   git commit -m "feat(server): add getSubagentActivities projection query"
   ```

---

## Task 4: `subscribeSubagentTree` WS handler

**Files:**

- Modify: `apps/server/src/ws.ts` (imports from `@t3tools/contracts`; `RPC_REQUIRED_SCOPE` map ~140–209; new filter helper near `isThreadDetailEvent` ~116–136; handler in `WsRpcGroup.of({...})` after `subscribeThread` ~1015)
- Test: `apps/server/src/server.test.ts`

1. - [ ] **Step 1 — Wire imports.** In `apps/server/src/ws.ts`, the `@t3tools/contracts` import block already brings in `ORCHESTRATION_WS_METHODS`, `OrchestrationEvent`, `OrchestrationGetSnapshotError`, `AuthOrchestrationReadScope`, etc. Confirm `RuntimeItemId` and `OrchestrationSubagentTreeStreamItem` are importable; you do not need the stream-item type at runtime (handlers return plain objects validated by the RPC success schema), so no new value import is strictly required. Add `RuntimeItemId` to the contracts import only if you reference it in a type annotation below (the handler below does not).

2. - [ ] **Step 2 — Add the auth scope.** In the `RPC_REQUIRED_SCOPE` map (~140–209), add after the `subscribeThread` entry (~147):

   ```ts
     [ORCHESTRATION_WS_METHODS.subscribeThread, AuthOrchestrationReadScope],
     [ORCHESTRATION_WS_METHODS.subscribeSubagentTree, AuthOrchestrationReadScope],
     [ORCHESTRATION_WS_METHODS.subscribeSubagent, AuthOrchestrationReadScope],
   ```

   (Add both here so Task 5 does not need to touch the map again.)

3. - [ ] **Step 3 — Add a tree-ref event filter helper.** Near `isThreadDetailEvent` (~116–136), add a predicate that recognizes a `thread.activity-appended` event that represents a subagent root ref status change. The root ref activity is a `collab_agent_tool_call` whose `itemId` is set; its `kind` lifecycle transitions (`tool.started`/`tool.updated`/`tool.completed`/`tool.failed`/`tool.denied`) change the ref status. Subagent CHILD activities (which carry `parentItemId`) are NOT tree-ref changes — they belong to `subscribeSubagent`:

   ```ts
   function isSubagentRootRefEvent(
     event: OrchestrationEvent,
   ): event is Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
     if (event.type !== "thread.activity-appended") {
       return false;
     }
     const activity = event.payload.activity;
     // A subagent root ref is a collab_agent_tool_call with an itemId and no parentItemId.
     // `itemType` lives on the activity payload (provider runtime detail), not on the
     // top-level activity body — read it defensively.
     const payload = activity.payload as { itemType?: unknown } | null | undefined;
     const itemType = payload && typeof payload === "object" ? payload.itemType : undefined;
     const itemId = "itemId" in activity ? activity.itemId : undefined;
     const parentItemId = "parentItemId" in activity ? activity.parentItemId : undefined;
     return (
       itemType === "collab_agent_tool_call" &&
       itemId !== undefined &&
       itemId !== null &&
       (parentItemId === undefined || parentItemId === null)
     );
   }
   ```

   NOTE on `itemType`: confirm where the provider stamps `collab_agent_tool_call` — Phase-1 grounding says the root `Task` tool call is `itemType: "collab_agent_tool_call"` with `parentItemId` absent. In the current ingestion (`ProviderRuntimeIngestion.ts`), `itemType` is carried on the activity `payload` (e.g. `payload.itemType`), and `itemId` is promoted to the top-level activity by Phase 1. If Phase 1 also promoted `itemType` to the top level, prefer reading `activity.itemType` directly. Keep the predicate matching exactly the root ref so child activities never produce a `ref-changed`.

   ALSO add a small mapper that turns the matched event into a `ref-changed` stream item by re-reading the ref from `ProjectionSnapshotQuery.getSubagentTree` and selecting the changed ref (so `depth`/`childSubagentCount`/`status` are always consistent). Define it inside the handler (Step 4) where `projectionSnapshotQuery` is in scope.

4. - [ ] **Step 4 — Add the handler.** In the `WsRpcGroup.of({ ... })` map (~788+), after the `subscribeThread` handler (ends ~1015), add:

   ```ts
   [ORCHESTRATION_WS_METHODS.subscribeSubagentTree]: (input) =>
     observeRpcStreamEffect(
       ORCHESTRATION_WS_METHODS.subscribeSubagentTree,
       Effect.gen(function* () {
         const [refs, snapshotSequence] = yield* Effect.all([
           projectionSnapshotQuery.getSubagentTree({ threadId: input.threadId }).pipe(
             Effect.mapError(
               (cause) =>
                 new OrchestrationGetSnapshotError({
                   message: `Failed to load subagent tree for thread ${input.threadId}`,
                   cause,
                 }),
             ),
           ),
           projectionSnapshotQuery.getSnapshotSequence().pipe(
             Effect.map(({ snapshotSequence }) => snapshotSequence),
             Effect.mapError(
               (cause) =>
                 new OrchestrationGetSnapshotError({
                   message: "Failed to load orchestration snapshot sequence",
                   cause,
                 }),
             ),
           ),
         ]);

         // When a subagent root ref appears/changes status, recompute the tree and
         // emit the single changed ref. (ref-removed is unused — refs persist — but the
         // union arm exists for completeness.)
         const liveStream = orchestrationEngine.streamDomainEvents.pipe(
           Stream.filter(
             (event) =>
               event.aggregateKind === "thread" &&
               event.aggregateId === input.threadId &&
               isSubagentRootRefEvent(event),
           ),
           Stream.mapEffect((event) =>
             projectionSnapshotQuery.getSubagentTree({ threadId: input.threadId }).pipe(
               Effect.map((nextRefs) => {
                 const activity = event.payload.activity;
                 const changedItemId = "itemId" in activity ? activity.itemId : undefined;
                 const changed = nextRefs.find((ref) => ref.rootItemId === changedItemId);
                 return changed === undefined
                   ? Option.none<typeof changed>()
                   : Option.some(changed);
               }),
               Effect.orElseSucceed(() => Option.none()),
             ),
           ),
           Stream.flatMap((ref) =>
             Option.isSome(ref)
               ? Stream.succeed({ kind: "ref-changed" as const, ref: ref.value })
               : Stream.empty,
           ),
         );

         return Stream.concat(
           Stream.make({
             kind: "snapshot" as const,
             snapshot: {
               snapshotSequence,
               threadId: input.threadId,
               refs,
             },
           }),
           liveStream,
         );
       }),
       { "rpc.aggregate": "orchestration" },
     ),
   ```

   This mirrors `subscribeThread` (~957–1015) exactly: `observeRpcStreamEffect` wrapper, `Effect.all([snapshot, getSnapshotSequence])`, mapError → `OrchestrationGetSnapshotError`, `streamDomainEvents.pipe(Stream.filter(...))`, `Stream.concat(Stream.make({ kind: "snapshot", ... }), liveStream)`. The `Stream.mapEffect` + `Stream.flatMap` over `Option` mirrors `subscribeShell`'s `toShellStreamEvent` (~923–928). Note there is no `Option.isNone` "not found" guard for the tree — an empty thread legitimately has zero refs and should return `{ refs: [] }` (do NOT fail with `OrchestrationGetSnapshotError` on empty).

5. - [ ] **Step 5 — Write the integration test.** In `apps/server/src/server.test.ts`, add a test in the same describe block as the existing orchestration ws tests (the `subscribeShell` error test is at ~5407; the harness helpers `buildAppUnderTest`, `withWsRpcClient`, `getWsServerUrl` are defined in this file). Override `getSubagentTree` to return one ref, and `streamDomainEvents` to emit a single `thread.activity-appended` root-ref event so the handler emits a live `ref-changed`:

   ```ts
   it.effect("routes websocket rpc subscribeSubagentTree emits snapshot then ref-changed", () =>
     Effect.gen(function* () {
       const threadId = ThreadId.make("thread-1");
       const baseRef = {
         threadId,
         rootItemId: RuntimeItemId.make("item-root-a"),
         parentItemId: null,
         label: "Explore: find the bug",
         subagentType: "Explore",
         description: "find the bug",
         status: "inProgress" as const,
         iteration: null,
         turnId: null,
         depth: 0,
         childSubagentCount: 0,
         createdAt: "2026-06-20T00:00:01.000Z",
         updatedAt: "2026-06-20T00:00:01.000Z",
       };

       yield* buildAppUnderTest({
         layers: {
           projectionSnapshotQuery: {
             getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 7 }),
             getSubagentTree: () => Effect.succeed([baseRef]),
           },
           orchestrationEngine: {
             streamDomainEvents: Stream.make({
               sequence: 8,
               eventId: EventId.make("event-ref-1"),
               aggregateKind: "thread" as const,
               aggregateId: threadId,
               occurredAt: "2026-06-20T00:00:02.000Z",
               commandId: null,
               causationEventId: null,
               correlationId: null,
               metadata: {},
               type: "thread.activity-appended" as const,
               payload: {
                 threadId,
                 activity: {
                   id: EventId.make("act-root-a"),
                   tone: "tool" as const,
                   kind: "tool.started",
                   summary: "Explore: find the bug",
                   payload: {
                     itemType: "collab_agent_tool_call",
                     itemId: "item-root-a",
                   },
                   turnId: null,
                   itemId: RuntimeItemId.make("item-root-a"),
                   createdAt: "2026-06-20T00:00:02.000Z",
                 },
               },
             }),
           },
         },
       });

       const wsUrl = yield* getWsServerUrl("/ws");
       const events = yield* Effect.scoped(
         withWsRpcClient(wsUrl, (client) =>
           client[ORCHESTRATION_WS_METHODS.subscribeSubagentTree]({ threadId }).pipe(
             Stream.take(2),
             Stream.runCollect,
           ),
         ),
       );

       const [first, second] = Array.from(events);
       assert.equal(first?.kind, "snapshot");
       if (first?.kind === "snapshot") {
         assert.equal(first.snapshot.snapshotSequence, 7);
         assert.equal(first.snapshot.threadId, threadId);
         assert.equal(first.snapshot.refs.length, 1);
         assert.equal(first.snapshot.refs[0]?.rootItemId, "item-root-a");
       }
       assert.equal(second?.kind, "ref-changed");
       if (second?.kind === "ref-changed") {
         assert.equal(second.ref.rootItemId, "item-root-a");
       }
     }).pipe(Effect.provide(NodeHttpServer.layerTest)),
   );
   ```

   Ensure `RuntimeItemId` is in the `@t3tools/contracts` import at the top of `server.test.ts` (`ThreadId`, `EventId` are already imported). Confirm the activity object shape matches `OrchestrationThreadActivity` after Phase 1 (the `itemId` top-level field) — if `itemId` is not yet a top-level activity field, drop it from the seed and have `isSubagentRootRefEvent` read `activity.payload.itemId` instead, and make the handler's `changedItemId` read the same path consistently.

6. - [ ] **Step 6 — Run the integration test (expect PASS).**

   ```
   pnpm --filter t3 test server
   ```

   (Or narrow: `pnpm --filter t3 test server.test`.) Expected: PASS. If only the snapshot arrives and the stream hangs on `Stream.take(2)`, the live filter rejected the event — log the event in `isSubagentRootRefEvent` and confirm `itemType`/`itemId` are read from the right location.

7. - [ ] **Step 7 — Typecheck (expect PASS).**

   ```
   cd apps/server && npx tsgo --noEmit
   ```

8. - [ ] **Step 8 — Commit.**
   ```
   git add apps/server/src/ws.ts apps/server/src/server.test.ts
   git commit -m "feat(server): add subscribeSubagentTree ws handler"
   ```

---

## Task 5: `subscribeSubagent` WS handler

**Files:**

- Modify: `apps/server/src/ws.ts` (new filter helper near `isThreadDetailEvent`; handler after `subscribeSubagentTree`)
- Test: `apps/server/src/server.test.ts`

1. - [ ] **Step 1 — Add a direct-child event filter helper.** Near `isThreadDetailEvent` / `isSubagentRootRefEvent` (~116–136), add a predicate factory that matches a `thread.activity-appended` whose activity's `parentItemId === rootItemId` (the subagent's direct children only):

   ```ts
   function isSubagentDirectChildEvent(
     event: OrchestrationEvent,
     rootItemId: string,
   ): event is Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
     if (event.type !== "thread.activity-appended") {
       return false;
     }
     const activity = event.payload.activity;
     const parentItemId = "parentItemId" in activity ? activity.parentItemId : undefined;
     return parentItemId === rootItemId;
   }
   ```

   If Phase 1 carries `parentItemId` on the activity `payload` rather than the top level, read `(activity.payload as { parentItemId?: string }).parentItemId` instead — match whatever Task 3's `getSubagentActivities` mapping uses, so snapshot and live stream agree.

2. - [ ] **Step 2 — Add the handler.** In the `WsRpcGroup.of({ ... })` map, after the `subscribeSubagentTree` handler, add:

   ```ts
   [ORCHESTRATION_WS_METHODS.subscribeSubagent]: (input) =>
     observeRpcStreamEffect(
       ORCHESTRATION_WS_METHODS.subscribeSubagent,
       Effect.gen(function* () {
         const [activities, snapshotSequence] = yield* Effect.all([
           projectionSnapshotQuery
             .getSubagentActivities({
               threadId: input.threadId,
               rootItemId: input.rootItemId,
             })
             .pipe(
               Effect.mapError(
                 (cause) =>
                   new OrchestrationGetSnapshotError({
                     message: `Failed to load subagent ${input.rootItemId} for thread ${input.threadId}`,
                     cause,
                   }),
               ),
             ),
           projectionSnapshotQuery.getSnapshotSequence().pipe(
             Effect.map(({ snapshotSequence }) => snapshotSequence),
             Effect.mapError(
               (cause) =>
                 new OrchestrationGetSnapshotError({
                   message: "Failed to load orchestration snapshot sequence",
                   cause,
                 }),
             ),
           ),
         ]);

         const liveStream = orchestrationEngine.streamDomainEvents.pipe(
           Stream.filter(
             (event) =>
               event.aggregateKind === "thread" &&
               event.aggregateId === input.threadId &&
               isSubagentDirectChildEvent(event, input.rootItemId),
           ),
           Stream.map((event) => ({
             kind: "event" as const,
             event,
           })),
         );

         return Stream.concat(
           Stream.make({
             kind: "snapshot" as const,
             snapshot: {
               snapshotSequence,
               threadId: input.threadId,
               rootItemId: input.rootItemId,
               activities,
             },
           }),
           liveStream,
         );
       }),
       { "rpc.aggregate": "orchestration" },
     ),
   ```

   This mirrors `subscribeThread` exactly (snapshot + `getSnapshotSequence`, `streamDomainEvents.pipe(Stream.filter(...), Stream.map(...))`, `Stream.concat`). Like the tree handler, an empty subagent legitimately returns `{ activities: [] }` — do NOT fail on empty. (`input.rootItemId` is a `RuntimeItemId` brand; compare against `parentItemId` as strings — branded ids are strings at runtime, so `parentItemId === input.rootItemId` works; if TS complains in the helper, type the `rootItemId` param as `string`.)

3. - [ ] **Step 3 — Write the integration test.** In `apps/server/src/server.test.ts`, add:

   ```ts
   it.effect("routes websocket rpc subscribeSubagent emits snapshot then a live child event", () =>
     Effect.gen(function* () {
       const threadId = ThreadId.make("thread-1");
       const rootItemId = RuntimeItemId.make("item-root-a");
       const snapshotChild = {
         id: EventId.make("act-direct-1"),
         tone: "tool" as const,
         kind: "tool.completed",
         summary: "Read file",
         payload: { itemType: "command_execution", itemId: "item-direct-1" },
         turnId: null,
         createdAt: "2026-06-20T00:00:02.000Z",
       };

       yield* buildAppUnderTest({
         layers: {
           projectionSnapshotQuery: {
             getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 9 }),
             getSubagentActivities: () => Effect.succeed([snapshotChild]),
           },
           orchestrationEngine: {
             streamDomainEvents: Stream.make({
               sequence: 10,
               eventId: EventId.make("event-child-1"),
               aggregateKind: "thread" as const,
               aggregateId: threadId,
               occurredAt: "2026-06-20T00:00:03.000Z",
               commandId: null,
               causationEventId: null,
               correlationId: null,
               metadata: {},
               type: "thread.activity-appended" as const,
               payload: {
                 threadId,
                 activity: {
                   id: EventId.make("act-direct-2"),
                   tone: "info" as const,
                   kind: "assistant.message",
                   summary: "Found it",
                   payload: { itemType: "assistant_message", itemId: "item-direct-2" },
                   turnId: null,
                   parentItemId: RuntimeItemId.make("item-root-a"),
                   createdAt: "2026-06-20T00:00:03.000Z",
                 },
               },
             }),
           },
         },
       });

       const wsUrl = yield* getWsServerUrl("/ws");
       const events = yield* Effect.scoped(
         withWsRpcClient(wsUrl, (client) =>
           client[ORCHESTRATION_WS_METHODS.subscribeSubagent]({ threadId, rootItemId }).pipe(
             Stream.take(2),
             Stream.runCollect,
           ),
         ),
       );

       const [first, second] = Array.from(events);
       assert.equal(first?.kind, "snapshot");
       if (first?.kind === "snapshot") {
         assert.equal(first.snapshot.snapshotSequence, 9);
         assert.equal(first.snapshot.rootItemId, rootItemId);
         assert.equal(first.snapshot.activities.length, 1);
         assert.equal(first.snapshot.activities[0]?.id, "act-direct-1");
       }
       assert.equal(second?.kind, "event");
       if (second?.kind === "event" && second.event.type === "thread.activity-appended") {
         assert.equal(second.event.payload.activity.id, "act-direct-2");
       }
     }).pipe(Effect.provide(NodeHttpServer.layerTest)),
   );
   ```

   Confirm the seeded child activity (with `parentItemId`) decodes against `OrchestrationThreadActivity` after Phase 1; if `parentItemId` lives on `payload`, move it there and have `isSubagentDirectChildEvent` read it from `payload`.

4. - [ ] **Step 4 — Run the integration test (expect PASS).**

   ```
   pnpm --filter t3 test server
   ```

   Expected: PASS. If the live event never arrives, the `parentItemId === rootItemId` comparison failed — log both values and confirm the read path matches Task 3.

5. - [ ] **Step 5 — Typecheck (expect PASS).**

   ```
   cd apps/server && npx tsgo --noEmit
   ```

6. - [ ] **Step 6 — Commit.**
   ```
   git add apps/server/src/ws.ts apps/server/src/server.test.ts
   git commit -m "feat(server): add subscribeSubagent ws handler"
   ```

---

## Task 6: Phase verification — deep (2-level) structure end-to-end

**Files:**

- Test: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` (one combined test exercising both queries against a 2-level structure)

1. - [ ] **Step 1 — Add the deep-structure verification test.** This is a query-level test (no ws needed) proving depth 0/1 in `getSubagentTree` and that `getSubagentActivities` on the level-1 root returns only its direct children:

   ```ts
   it.effect("deep 2-level subagent structure: correct depths and direct-children isolation", () =>
     Effect.gen(function* () {
       const snapshotQuery = yield* ProjectionSnapshotQuery;
       const sql = yield* SqlClient.SqlClient;

       yield* sql`DELETE FROM projection_thread_activities`;
       yield* sql`DELETE FROM projection_threads`;
       yield* sql`DELETE FROM projection_projects`;

       yield* sql`
         INSERT INTO projection_projects (
           project_id, title, workspace_root, default_model_selection_json,
           scripts_json, created_at, updated_at, deleted_at
         ) VALUES (
           'project-1', 'Project 1', '/tmp/project-1',
           '{"provider":"codex","model":"gpt-5-codex"}', '[]',
           '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
         )
       `;
       yield* sql`
         INSERT INTO projection_threads (
           thread_id, project_id, title, model_selection_json, runtime_mode,
           interaction_mode, branch, worktree_path, latest_turn_id,
           latest_user_message_at, pending_approval_count, pending_user_input_count,
           has_actionable_proposed_plan, created_at, updated_at, deleted_at
         ) VALUES (
           'thread-1', 'project-1', 'Thread 1',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, NULL, 'turn-1', '2026-06-20T00:00:00.000Z', 0, 0, 0,
           '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', NULL
         )
       `;

       // Level-0 root.
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-L0', 'thread-1', 'turn-1', 'tool', 'tool.started',
           'Explore: top level',
           '{"itemType":"collab_agent_tool_call","itemId":"item-L0"}',
           '2026-06-20T00:00:01.000Z', 'item-L0', NULL, 1
         )
       `;
       // Level-1 root (child subagent of L0).
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-L1', 'thread-1', 'turn-1', 'tool', 'tool.started',
           'Plan: nested level',
           '{"itemType":"collab_agent_tool_call","itemId":"item-L1"}',
           '2026-06-20T00:00:02.000Z', 'item-L1', 'item-L0', 1
         )
       `;
       // A direct child activity of the level-1 root.
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-L1-child', 'thread-1', 'turn-1', 'tool', 'tool.completed',
           'Read file in nested',
           '{"itemType":"command_execution","itemId":"item-L1-child"}',
           '2026-06-20T00:00:03.000Z', 'item-L1-child', 'item-L1', 1
         )
       `;
       // A direct child activity of the level-0 root (must NOT show under L1).
       yield* sql`
         INSERT INTO projection_thread_activities (
           activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
           created_at, item_id, parent_item_id, iteration
         ) VALUES (
           'act-L0-child', 'thread-1', 'turn-1', 'info', 'assistant.message',
           'Top-level note', '{"itemType":"assistant_message","itemId":"item-L0-child"}',
           '2026-06-20T00:00:04.000Z', 'item-L0-child', 'item-L0', 1
         )
       `;

       const refs = yield* snapshotQuery.getSubagentTree({ threadId: ThreadId.make("thread-1") });
       const byItem = new Map(refs.map((r) => [r.rootItemId, r]));
       assert.equal(refs.length, 2);
       assert.equal(byItem.get("item-L0")?.depth, 0);
       assert.equal(byItem.get("item-L0")?.childSubagentCount, 1);
       assert.equal(byItem.get("item-L1")?.depth, 1);
       assert.equal(byItem.get("item-L1")?.parentItemId, "item-L0");
       assert.equal(byItem.get("item-L1")?.childSubagentCount, 0);

       const l1Activities = yield* snapshotQuery.getSubagentActivities({
         threadId: ThreadId.make("thread-1"),
         rootItemId: RuntimeItemId.make("item-L1"),
       });
       // Direct children of the level-1 root only: act-L1-child (and the nested ref act-L1
       // belongs under L0, not L1). act-L0-child must be excluded.
       assert.equal(
         l1Activities.some((a) => a.id === "act-L1-child"),
         true,
       );
       assert.equal(
         l1Activities.some((a) => a.id === "act-L0-child"),
         false,
       );
     }),
   );
   ```

   Note: whether `getSubagentActivities({ rootItemId: "item-L1" })` includes the nested subagent ref row itself depends on whether Phase-1 `listSubagentChildActivityRows` returns rows where `parent_item_id = :parentItemId` regardless of `itemType`. The watch view shows the subagent's transcript including nested refs to drill into — so including the ref row is acceptable. The load-bearing assertions are: `act-L1-child` IS present and `act-L0-child` is NOT.

2. - [ ] **Step 2 — Run the verification test (expect PASS).**

   ```
   pnpm --filter t3 test ProjectionSnapshotQuery
   ```

   Expected: PASS, plus all earlier ProjectionSnapshotQuery tests still green.

3. - [ ] **Step 3 — Run the full affected test surface (expect PASS).**

   ```
   pnpm --filter @t3tools/contracts test orchestration
   pnpm --filter t3 test ProjectionSnapshotQuery
   pnpm --filter t3 test server
   ```

   Expected: all PASS.

4. - [ ] **Step 4 — Lint + typecheck the whole repo (expect PASS).**

   ```
   pnpm lint
   cd packages/contracts && npx tsgo --noEmit
   cd ../../apps/server && npx tsgo --noEmit
   ```

   Expected: clean. Per repo convention (`AGENTS.md`), `vp check` and `vp run typecheck` must also pass before the phase is considered complete:

   ```
   vp check
   vp run typecheck
   ```

5. - [ ] **Step 5 — Commit.**
   ```
   git add apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts
   git commit -m "test(server): verify deep subagent tree depths and direct-children isolation"
   ```

---

## Phase 2 self-check

Before declaring Phase 2 done, confirm every item:

- [ ] `packages/contracts/src/orchestration.ts` exports `OrchestrationSubagentStatus`, `OrchestrationSubagentRef`, `OrchestrationSubscribeSubagentTreeInput`, `OrchestrationSubagentTreeSnapshot`, `OrchestrationSubagentTreeStreamItem`, `OrchestrationSubscribeSubagentInput`, `OrchestrationSubagentActivitiesSnapshot`, `OrchestrationSubagentActivitiesStreamItem` — each with a matching `export type` — using the EXACT locked shapes (field names/order/`Schema.NullOr` wrappers).
- [ ] `ORCHESTRATION_WS_METHODS.subscribeSubagentTree === "orchestration.subscribeSubagentTree"` and `ORCHESTRATION_WS_METHODS.subscribeSubagent === "orchestration.subscribeSubagent"`.
- [ ] `OrchestrationRpcSchemas` has `subscribeSubagentTree` and `subscribeSubagent` `{ input, output }` entries.
- [ ] `packages/contracts/src/rpc.ts` defines `WsOrchestrationSubscribeSubagentTreeRpc` and `WsOrchestrationSubscribeSubagentRpc` via `Rpc.make(..., { payload, success, error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]), stream: true })`, and both are registered in `WsRpcGroup.make(...)`.
- [ ] `ProjectionSnapshotQuery` exposes `getSubagentTree({ threadId })` and `getSubagentActivities({ threadId, rootItemId })`, both in the shape interface AND the live layer's returned object.
- [ ] `apps/server/src/ws.ts` registers both handlers in `WsRpcGroup.of({...})` and both methods in `RPC_REQUIRED_SCOPE` with `AuthOrchestrationReadScope`.
- [ ] Tree snapshot returns refs (refs-only, no transcripts); tree live stream emits `ref-changed` only for subagent ROOT-ref `thread.activity-appended` events (child activities never produce `ref-changed`).
- [ ] Subagent snapshot returns ONLY direct children (`parentItemId === rootItemId`); live stream forwards `{ kind: "event", event }` only for `thread.activity-appended` whose activity's `parentItemId === rootItemId`.
- [ ] Empty thread / empty subagent return `{ refs: [] }` / `{ activities: [] }` (no `OrchestrationGetSnapshotError` on empty).
- [ ] Contract round-trip tests, both ProjectionSnapshotQuery unit tests, the deep-structure verification test, and both ws integration tests PASS.
- [ ] `pnpm lint`, per-package `npx tsgo --noEmit`, `vp check`, and `vp run typecheck` all pass.
- [ ] Reconciled every "confirm against Phase 1" note (Phase-1 row-schema field names: `itemId`/`parentItemId`/`summary`/`kind`/`turnId`/`iteration`/`createdAt`; and where `itemType`/`itemId`/`parentItemId` live on the activity — top-level vs `payload`). Snapshot mapping and live-stream filters MUST read these from the same place.

> Phase 3 (web UI) consumes these two RPC methods (`subscribeSubagentTree`, `subscribeSubagent`) plus the `OrchestrationSubagentRef` / `OrchestrationSubagentTreeStreamItem` / `OrchestrationSubagentActivitiesStreamItem` schemas to render the sidebar subagent tree and the read-only watch view.
