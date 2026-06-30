# Subagent Session Tree — Phase 1: Storage Decoupling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple subagent transcripts from the parent thread snapshot so long/unattended sessions refresh fast, and classify subagent activities for the tree/watch features.

**Architecture:** Add item_id/parent_item_id/iteration columns to projection_thread_activities; stamp them at ingestion; exclude parent_item_id-bearing rows from the parent thread snapshot and in-memory projector; maintain has_subagents/live_subagent_count on projection_threads following the pendingApprovalCount precedent.

**Tech Stack:** TypeScript, Effect (effect/Schema, effect/unstable/sql), Node sqlite, Vitest.

---

## Orientation (read before starting)

This phase is **storage-only**. After it lands, parent `subscribeThread` snapshots shrink (subagent-child transcripts are excluded), every activity row is classified by `itemId`/`parentItemId`/`iteration`, and `projection_threads` carries `has_subagents` / `live_subagent_count` summary counts. No new WebSocket endpoints, no web changes — those are Phase 2+.

**Contract surface this phase LOCKS (later phases depend on these exact names/shapes):**

- `projection_thread_activities` gains columns `item_id TEXT NULL`, `parent_item_id TEXT NULL`, `iteration INTEGER NULL`, and index `idx_projection_thread_activities_thread_parent_created` on `(thread_id, parent_item_id, created_at)`.
- `projection_threads` gains columns `has_subagents INTEGER NOT NULL DEFAULT 0`, `live_subagent_count INTEGER NOT NULL DEFAULT 0`.
- `OrchestrationThreadActivity` gains optional top-level `itemId` / `parentItemId` / `iteration`.
- `OrchestrationThreadShell` gains `hasSubagents` (Boolean, decoding default `false`), `liveSubagentCount` (NonNegativeInt, decoding default `0`), and `unattendedRun` (nullable `UnattendedRunState`, decoding default `null`).
- Persistence service `ProjectionThreadActivity` gains optional `itemId` / `parentItemId` / `iteration`.
- New `ProjectionSnapshotQuery` queries: `listThreadActivityRowsByThread` filtered to `parent_item_id IS NULL`; new `listSubagentChildActivityRows({ threadId, parentItemId })` and `listSubagentRootRefRows({ threadId })`.
- `subagentRootItemId` is intentionally NOT implemented — do not add it.

**Conventions:**

- Contracts tests: `pnpm --filter @t3tools/contracts test <pattern>`
- Server tests: `pnpm --filter t3 test <pattern>`
- Per-package typecheck: `cd <package dir> && npx tsgo --noEmit`
- Lint: `pnpm lint`
- Before considering ANY task "done" the repo gate from `AGENTS.md` applies: `vp check` and `vp run typecheck` must pass.
- All migrations begin with this header:

  ```ts
  import * as SqlClient from "effect/unstable/sql/SqlClient";
  import * as Effect from "effect/Effect";

  export default Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // ...
  });
  ```

---

## Task 1: Extend `OrchestrationThreadActivity` contract with itemId/parentItemId/iteration

**Files:**

- Modify: `packages/contracts/src/orchestration.ts` (struct at lines 345-355; verify `RuntimeItemId`/`PositiveInt` import source)
- Test: `packages/contracts/src/orchestration.test.ts` (mirror the `it.effect` round-trip style at lines 53-113)

- [ ] **Step 1: Verify the imports.** `RuntimeItemId` and `PositiveInt` both live in `packages/contracts/src/baseSchemas.ts` (lines 17, 51) and are re-exported through the contracts barrel. `orchestration.ts` already imports `EventId`, `IsoDateTime`, `NonNegativeInt`, `PositiveInt`, `RuntimeItemId`, `TurnId`, `TrimmedNonEmptyString` from `./baseSchemas.ts`. Confirm with:

  ```bash
  grep -n "RuntimeItemId\|PositiveInt" packages/contracts/src/orchestration.ts | head
  ```

  If `RuntimeItemId` is NOT in the existing `from "./baseSchemas.ts"` import list, add it there. Do not add a second import line.

- [ ] **Step 2: Write the failing round-trip test.** Append this to `packages/contracts/src/orchestration.test.ts`. First add `OrchestrationThreadActivity` to the existing import block from `./orchestration.ts` (the block at lines 5-24), then add a decoder constant near the others (after line 51) and the tests:

  ```ts
  const decodeOrchestrationThreadActivity = Schema.decodeUnknownEffect(OrchestrationThreadActivity);
  const encodeOrchestrationThreadActivity = Schema.encodeUnknownEffect(OrchestrationThreadActivity);

  it.effect("round-trips a thread activity carrying itemId/parentItemId/iteration", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeOrchestrationThreadActivity({
        id: "activity-sub-1",
        tone: "info",
        kind: "tool.completed",
        summary: "Subagent message",
        payload: { itemType: "assistant_message", status: "completed" },
        turnId: "turn-1",
        itemId: "item-child-1",
        parentItemId: "item-root-1",
        iteration: 2,
        createdAt: "2026-06-20T00:00:00.000Z",
      });
      assert.strictEqual(decoded.itemId, "item-child-1");
      assert.strictEqual(decoded.parentItemId, "item-root-1");
      assert.strictEqual(decoded.iteration, 2);

      const encoded = yield* encodeOrchestrationThreadActivity(decoded);
      assert.strictEqual(encoded.itemId, "item-child-1");
      assert.strictEqual(encoded.parentItemId, "item-root-1");
      assert.strictEqual(encoded.iteration, 2);
    }),
  );

  it.effect("decodes a thread activity that omits the optional subagent fields", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeOrchestrationThreadActivity({
        id: "activity-plain-1",
        tone: "tool",
        kind: "tool.started",
        summary: "Edit file started",
        payload: { itemType: "command" },
        turnId: "turn-1",
        createdAt: "2026-06-20T00:00:00.000Z",
      });
      assert.strictEqual(decoded.itemId, undefined);
      assert.strictEqual(decoded.parentItemId, undefined);
      assert.strictEqual(decoded.iteration, undefined);
    }),
  );
  ```

  Run it — it MUST FAIL (the fields do not exist yet):

  ```bash
  pnpm --filter @t3tools/contracts test orchestration
  ```

  Expected: FAIL (decoded.itemId is undefined where the round-trip test expects "item-child-1", or a type/decode error).

- [ ] **Step 3: Add the three optional fields to the contract.** In `packages/contracts/src/orchestration.ts`, replace the struct at lines 345-355:

  ```ts
  export const OrchestrationThreadActivity = Schema.Struct({
    id: EventId,
    tone: OrchestrationThreadActivityTone,
    kind: TrimmedNonEmptyString,
    summary: TrimmedNonEmptyString,
    payload: Schema.Unknown,
    turnId: Schema.NullOr(TurnId),
    sequence: Schema.optional(NonNegativeInt),
    createdAt: IsoDateTime,
  });
  export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;
  ```

  with:

  ```ts
  export const OrchestrationThreadActivity = Schema.Struct({
    id: EventId,
    tone: OrchestrationThreadActivityTone,
    kind: TrimmedNonEmptyString,
    summary: TrimmedNonEmptyString,
    payload: Schema.Unknown,
    turnId: Schema.NullOr(TurnId),
    sequence: Schema.optional(NonNegativeInt),
    itemId: Schema.optional(RuntimeItemId),
    parentItemId: Schema.optional(RuntimeItemId),
    iteration: Schema.optional(PositiveInt),
    createdAt: IsoDateTime,
  });
  export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;
  ```

- [ ] **Step 4: Re-run the test — it MUST PASS.**

  ```bash
  pnpm --filter @t3tools/contracts test orchestration
  ```

  Expected: PASS (both new tests green, all existing tests still green).

- [ ] **Step 5: Typecheck the contracts package.**

  ```bash
  cd packages/contracts && npx tsgo --noEmit
  ```

  Expected: no errors.

- [ ] **Step 6: Commit.**
  ```bash
  git add packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts
  git commit -m "feat(contracts): add optional itemId/parentItemId/iteration to OrchestrationThreadActivity"
  ```

---

## Task 2: Migration 034 — add activity classification columns + index + backfill

**Files:**

- Create: `apps/server/src/persistence/Migrations/034_ProjectionThreadActivitiesSubagentColumns.ts`
- Modify: `apps/server/src/persistence/Migrations.ts` (import block lines 16-48; `migrationEntries` array lines 60-94)
- Reference: `apps/server/src/persistence/Migrations/033_ProjectionThreadsUnattendedRun.ts` (PRAGMA-guarded ADD COLUMN), `apps/server/src/persistence/Migrations/024_BackfillProjectionThreadShellSummary.ts` (json_extract backfill)

- [ ] **Step 1: Create the migration file.** Write `apps/server/src/persistence/Migrations/034_ProjectionThreadActivitiesSubagentColumns.ts` with this exact content. It is PRAGMA-guarded (idempotent), adds the three columns, the new index, and backfills `item_id` / `parent_item_id` from `payload_json` for historical rows. Iteration is left NULL on backfill (it was never stored in legacy payloads).

  ```ts
  import * as SqlClient from "effect/unstable/sql/SqlClient";
  import * as Effect from "effect/Effect";

  export default Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_thread_activities)
    `;

    if (!columns.some((column) => column.name === "item_id")) {
      yield* sql`
        ALTER TABLE projection_thread_activities
        ADD COLUMN item_id TEXT
      `;
    }

    if (!columns.some((column) => column.name === "parent_item_id")) {
      yield* sql`
        ALTER TABLE projection_thread_activities
        ADD COLUMN parent_item_id TEXT
      `;
    }

    if (!columns.some((column) => column.name === "iteration")) {
      yield* sql`
        ALTER TABLE projection_thread_activities
        ADD COLUMN iteration INTEGER
      `;
    }

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_parent_created
      ON projection_thread_activities(thread_id, parent_item_id, created_at)
    `;

    yield* sql`
      UPDATE projection_thread_activities
      SET item_id = json_extract(payload_json, '$.itemId')
      WHERE item_id IS NULL
        AND json_extract(payload_json, '$.itemId') IS NOT NULL
    `;

    yield* sql`
      UPDATE projection_thread_activities
      SET parent_item_id = json_extract(payload_json, '$.parentItemId')
      WHERE parent_item_id IS NULL
        AND json_extract(payload_json, '$.parentItemId') IS NOT NULL
    `;
  });
  ```

- [ ] **Step 2: Register the migration in `apps/server/src/persistence/Migrations.ts`.** Add the import immediately after the `Migration0033` import (line 48):

  ```ts
  import Migration0034 from "./Migrations/034_ProjectionThreadActivitiesSubagentColumns.ts";
  ```

  Add the tuple to `migrationEntries` immediately after the `[33, ...]` entry (line 93), keeping the array literal `as const`:

  ```ts
    [33, "ProjectionThreadsUnattendedRun", Migration0033],
    [34, "ProjectionThreadActivitiesSubagentColumns", Migration0034],
  ] as const;
  ```

- [ ] **Step 3: Typecheck the server package.**

  ```bash
  cd apps/server && npx tsgo --noEmit
  ```

  Expected: no errors.

- [ ] **Step 4: Sanity-run the migration via an existing server test that boots `SqlitePersistenceMemory`.** The in-memory persistence layer runs all registered migrations on build, so any existing snapshot-query test exercises migration 034. Run:

  ```bash
  pnpm --filter t3 test ProjectionSnapshotQuery
  ```

  Expected: PASS (no migration error; the new columns exist so existing inserts/selects continue to work).

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/server/src/persistence/Migrations/034_ProjectionThreadActivitiesSubagentColumns.ts apps/server/src/persistence/Migrations.ts
  git commit -m "feat(server): migration 034 adds subagent classification columns to projection_thread_activities"
  ```

---

## Task 3: Extend persistence `ProjectionThreadActivity` service + write layer

**Files:**

- Modify: `apps/server/src/persistence/Services/ProjectionThreadActivities.ts` (struct lines 23-34; imports lines 9-16)
- Modify: `apps/server/src/persistence/Layers/ProjectionThreadActivities.ts` (DbRowSchema lines 19-24; INSERT lines 36-73; SELECT lines 75-98; row→domain map lines 119-140)

- [ ] **Step 1: Extend the service schema.** In `apps/server/src/persistence/Services/ProjectionThreadActivities.ts`, first add `RuntimeItemId` and `PositiveInt` to the import block (lines 9-16):

  ```ts
  import {
    EventId,
    IsoDateTime,
    NonNegativeInt,
    OrchestrationThreadActivityTone,
    PositiveInt,
    RuntimeItemId,
    ThreadId,
    TurnId,
  } from "@t3tools/contracts";
  ```

  Then replace the struct (lines 23-34):

  ```ts
  export const ProjectionThreadActivity = Schema.Struct({
    activityId: EventId,
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    tone: OrchestrationThreadActivityTone,
    kind: Schema.String,
    summary: Schema.String,
    payload: Schema.Unknown,
    sequence: Schema.optional(NonNegativeInt),
    createdAt: IsoDateTime,
  });
  export type ProjectionThreadActivity = typeof ProjectionThreadActivity.Type;
  ```

  with:

  ```ts
  export const ProjectionThreadActivity = Schema.Struct({
    activityId: EventId,
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    tone: OrchestrationThreadActivityTone,
    kind: Schema.String,
    summary: Schema.String,
    payload: Schema.Unknown,
    sequence: Schema.optional(NonNegativeInt),
    itemId: Schema.optional(RuntimeItemId),
    parentItemId: Schema.optional(RuntimeItemId),
    iteration: Schema.optional(PositiveInt),
    createdAt: IsoDateTime,
  });
  export type ProjectionThreadActivity = typeof ProjectionThreadActivity.Type;
  ```

- [ ] **Step 2: Extend the DB row schema in the write layer.** In `apps/server/src/persistence/Layers/ProjectionThreadActivities.ts`, replace the `ProjectionThreadActivityDbRowSchema` (lines 19-24):

  ```ts
  const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
    Struct.assign({
      payload: Schema.fromJsonString(Schema.Unknown),
      sequence: Schema.NullOr(NonNegativeInt),
    }),
  );
  ```

  with (the new columns arrive as nullable from SQL):

  ```ts
  const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
    Struct.assign({
      payload: Schema.fromJsonString(Schema.Unknown),
      sequence: Schema.NullOr(NonNegativeInt),
      itemId: Schema.NullOr(RuntimeItemId),
      parentItemId: Schema.NullOr(RuntimeItemId),
      iteration: Schema.NullOr(PositiveInt),
    }),
  );
  ```

  Add `PositiveInt` and `RuntimeItemId` to the `@t3tools/contracts` import (line 3 currently imports only `NonNegativeInt`):

  ```ts
  import { NonNegativeInt, PositiveInt, RuntimeItemId } from "@t3tools/contracts";
  ```

- [ ] **Step 3: Extend the INSERT.** Replace `upsertProjectionThreadActivityRow` (lines 36-73) with the version that writes the three columns. The new values use the same `?? null` guard as `sequence`:

  ```ts
  const upsertProjectionThreadActivityRow = SqlSchema.void({
    Request: ProjectionThreadActivity,
    execute: (row) =>
      sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              item_id,
              parent_item_id,
              iteration,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${JSON.stringify(row.payload)},
              ${row.sequence ?? null},
              ${row.itemId ?? null},
              ${row.parentItemId ?? null},
              ${row.iteration ?? null},
              ${row.createdAt}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              sequence = excluded.sequence,
              item_id = excluded.item_id,
              parent_item_id = excluded.parent_item_id,
              iteration = excluded.iteration,
              created_at = excluded.created_at
          `,
  });
  ```

- [ ] **Step 4: Extend the SELECT.** Replace `listProjectionThreadActivityRows` (lines 75-98) so the projection includes the three new columns aliased to camelCase:

  ```ts
  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          item_id AS "itemId",
          parent_item_id AS "parentItemId",
          iteration,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });
  ```

- [ ] **Step 5: Extend the row→domain map.** Replace the `Effect.map` block inside `listByThreadId` (lines 127-139) so the optional fields are conditionally spread exactly like `sequence`:

  ```ts
      Effect.map((rows) =>
        rows.map((row) => ({
          activityId: row.activityId,
          threadId: row.threadId,
          turnId: row.turnId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          ...(row.sequence !== null ? { sequence: row.sequence } : {}),
          ...(row.itemId !== null ? { itemId: row.itemId } : {}),
          ...(row.parentItemId !== null ? { parentItemId: row.parentItemId } : {}),
          ...(row.iteration !== null ? { iteration: row.iteration } : {}),
          createdAt: row.createdAt,
        })),
      ),
  ```

- [ ] **Step 6: Typecheck the server package.**

  ```bash
  cd apps/server && npx tsgo --noEmit
  ```

  Expected: no errors.

- [ ] **Step 7: Run the persistence-touching tests to confirm round-tripping.**

  ```bash
  pnpm --filter t3 test ProjectionPipeline
  ```

  Expected: PASS (existing activity upsert/list flows still work; the new optional columns default to absent).

- [ ] **Step 8: Commit.**
  ```bash
  git add apps/server/src/persistence/Services/ProjectionThreadActivities.ts apps/server/src/persistence/Layers/ProjectionThreadActivities.ts
  git commit -m "feat(server): persist itemId/parentItemId/iteration on projection thread activities"
  ```

---

## Task 4: Extend ProjectionSnapshotQuery — classify rows, exclude subagent children, add subtree queries

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (local DbRowSchema lines 84-89; `ThreadIdLookupInput` lines 118-120; `listThreadActivityRows` lines 450-472; `listThreadActivityRowsByThread` lines 816-838; `getThreadDetailById` activity map lines 2008-2022; service interface + return object)
- Reference: `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts` (the `ProjectionSnapshotQueryShape` interface — the two new methods must be declared there)

- [ ] **Step 1: Extend the local DB row schema.** In `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, replace the duplicated `ProjectionThreadActivityDbRowSchema` (lines 84-89):

  ```ts
  const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
    Struct.assign({
      payload: Schema.fromJsonString(Schema.Unknown),
      sequence: Schema.NullOr(NonNegativeInt),
    }),
  );
  ```

  with:

  ```ts
  const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
    Struct.assign({
      payload: Schema.fromJsonString(Schema.Unknown),
      sequence: Schema.NullOr(NonNegativeInt),
      itemId: Schema.NullOr(RuntimeItemId),
      parentItemId: Schema.NullOr(RuntimeItemId),
      iteration: Schema.NullOr(PositiveInt),
    }),
  );
  ```

  Confirm `RuntimeItemId` and `PositiveInt` are imported from `@t3tools/contracts` at the top of the file; if not, add them to the existing contracts import.

- [ ] **Step 2: Add the lookup input for the direct-children query.** Immediately after `ThreadIdLookupInput` (lines 118-120), add:

  ```ts
  const ThreadParentItemLookupInput = Schema.Struct({
    threadId: ThreadId,
    parentItemId: RuntimeItemId,
  });
  ```

- [ ] **Step 3: Add the new columns to the global activity SELECT.** Replace `listThreadActivityRows` (lines 450-472) so its projection includes the three columns (so global hydration carries classification):

  ```ts
  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          item_id AS "itemId",
          parent_item_id AS "parentItemId",
          iteration,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });
  ```

- [ ] **Step 4: Filter the thread-detail activity query to top-level rows (the exclusion).** Replace `listThreadActivityRowsByThread` (lines 816-838) — add the three columns AND the `AND parent_item_id IS NULL` filter that drops subagent transcripts from the parent snapshot:

  ```ts
  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          item_id AS "itemId",
          parent_item_id AS "parentItemId",
          iteration,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND parent_item_id IS NULL
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });
  ```

- [ ] **Step 5: Add the direct-children query (Phase 2 watch view; define now).** Immediately after `listThreadActivityRowsByThread`, add:

  ```ts
  const listSubagentChildActivityRowsByParent = SqlSchema.findAll({
    Request: ThreadParentItemLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, parentItemId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          item_id AS "itemId",
          parent_item_id AS "parentItemId",
          iteration,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND parent_item_id = ${parentItemId}
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });
  ```

- [ ] **Step 6: Add the subagent-root ref query (Phase 2 tree; define now).** Immediately after the previous query, add. Root refs are the top-level `collab_agent_tool_call` activities (`parent_item_id IS NULL`), identified via `json_extract(payload_json,'$.itemType')`:

  ```ts
  const listSubagentRootRefRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          item_id AS "itemId",
          parent_item_id AS "parentItemId",
          iteration,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND parent_item_id IS NULL
          AND json_extract(payload_json, '$.itemType') = 'collab_agent_tool_call'
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });
  ```

- [ ] **Step 7: Map the new fields into the thread-detail activity output.** Replace the `activities` map in `getThreadDetailById` (lines 2008-2022) so itemId/parentItemId/iteration are conditionally spread (parentItemId will always be absent here because of the WHERE filter, but the map must still carry itemId/iteration for the root refs):

  ```ts
        activities: activityRows.map((row) => {
          const activity = {
            id: row.activityId,
            tone: row.tone,
            kind: row.kind,
            summary: row.summary,
            payload: row.payload,
            turnId: row.turnId,
            ...(row.sequence !== null ? { sequence: row.sequence } : {}),
            ...(row.itemId !== null ? { itemId: row.itemId } : {}),
            ...(row.parentItemId !== null ? { parentItemId: row.parentItemId } : {}),
            ...(row.iteration !== null ? { iteration: row.iteration } : {}),
            createdAt: row.createdAt,
          };
          return activity;
        }),
  ```

  > Note: the original code used `Object.assign(activity, { sequence })` after construction because `sequence` was the only conditional field. With three more conditional fields the inline conditional-spread form above is equivalent and cleaner; it produces the same shape and decodes through `decodeThread` identically.

- [ ] **Step 8: Add the two new methods to the snapshot-query service interface.** Open `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`, find the `ProjectionSnapshotQueryShape` interface, and add (mirroring the existing `getThreadDetailById` signature shape; import `RuntimeItemId` and the activity type as needed):

  ```ts
    readonly listSubagentChildActivityRows: (input: {
      readonly threadId: ThreadId;
      readonly parentItemId: RuntimeItemId;
    }) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ProjectionRepositoryError>;

    readonly listSubagentRootRefRows: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ProjectionRepositoryError>;
  ```

  Use the exact error type the sibling methods use (read the file; most return `ProjectionRepositoryError` or the layer's `toPersistenceSqlOrDecodeError` channel — match it). If sibling methods return a different error type, match that type exactly rather than introducing a new one.

- [ ] **Step 9: Implement the two methods in the layer's returned object.** In `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, find the `return { ... }` object near the end (it begins at `return { getCommandReadModel, getSnapshot, ... }` around line 2045) and add two implementations alongside the existing ones. Each maps DB rows to `OrchestrationThreadActivity` with the same conditional-spread used in Step 7:

  ```ts
  const mapActivityRow = (
    row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
  ): OrchestrationThreadActivity => ({
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    ...(row.itemId !== null ? { itemId: row.itemId } : {}),
    ...(row.parentItemId !== null ? { parentItemId: row.parentItemId } : {}),
    ...(row.iteration !== null ? { iteration: row.iteration } : {}),
    createdAt: row.createdAt,
  });

  const listSubagentChildActivityRows: ProjectionSnapshotQueryShape["listSubagentChildActivityRows"] =
    ({ threadId, parentItemId }) =>
      listSubagentChildActivityRowsByParent({ threadId, parentItemId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listSubagentChildActivityRows:query",
            "ProjectionSnapshotQuery.listSubagentChildActivityRows:decodeRows",
          ),
        ),
        Effect.map((rows) => rows.map(mapActivityRow)),
      );

  const listSubagentRootRefRows: ProjectionSnapshotQueryShape["listSubagentRootRefRows"] = ({
    threadId,
  }) =>
    listSubagentRootRefRowsByThread({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listSubagentRootRefRows:query",
          "ProjectionSnapshotQuery.listSubagentRootRefRows:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(mapActivityRow)),
    );
  ```

  Then add `listSubagentChildActivityRows` and `listSubagentRootRefRows` to the returned object literal. Define `mapActivityRow` near the other local mapping helpers (e.g. next to `mapLatestTurn` around line 185) so it is in scope; if there is already an inline equivalent inside `getThreadDetailById` (Step 7), you may keep both inline or refactor `getThreadDetailById` to call `mapActivityRow` — either is acceptable, but if you refactor, re-run the snapshot test in Step 11.

- [ ] **Step 10: Typecheck the server package.**

  ```bash
  cd apps/server && npx tsgo --noEmit
  ```

  Expected: no errors.

- [ ] **Step 11: Run the snapshot-query tests.**

  ```bash
  pnpm --filter t3 test ProjectionSnapshotQuery
  ```

  Expected: PASS (existing thread-detail snapshot tests still green; rows without `parent_item_id` are unaffected by the new filter).

- [ ] **Step 12: Commit.**
  ```bash
  git add apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts
  git commit -m "feat(server): exclude subagent children from thread snapshot and add subagent subtree queries"
  ```

---

## Task 5: Ingestion — surface unattendedRun on the shell and stamp itemId/parentItemId/iteration

**Files:**

- Modify: `packages/contracts/src/orchestration.ts` (`OrchestrationThreadShell` lines 425-446)
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (`getThreadShellById` map lines 1884-1902)
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (`runtimeEventToActivities` lines 265-664; dispatch loop lines 1698-1711)
- Test: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`

- [ ] **Step 1: Add `unattendedRun` to `OrchestrationThreadShell` (needed so ingestion can read `currentIteration`).** In `packages/contracts/src/orchestration.ts`, in the struct at lines 425-446, add one field before the closing brace (after `hasActionableProposedPlan`). `UnattendedRunState` is already imported in this file (used by `OrchestrationThread`):

  ```ts
    hasActionableProposedPlan: Schema.Boolean,
    unattendedRun: Schema.NullOr(UnattendedRunState).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  });
  ```

- [ ] **Step 2: Map `unattendedRun` in `getThreadShellById`.** In `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, the shell object returned at lines 1884-1902 must include the field. `threadRow.value.unattendedRun` is already selected by `getActiveThreadRowById` (line 766). Add to the returned object (after `hasActionableProposedPlan`):

  ```ts
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        unattendedRun: threadRow.value.unattendedRun,
      } satisfies OrchestrationThreadShell);
  ```

- [ ] **Step 3: Map `unattendedRun` in the two shell-snapshot builders too.** Both `getShellSnapshot` (the thread object at lines 1510-1528) and `getArchivedShellSnapshot` (lines 1643-1662) build `OrchestrationThreadShell` objects and will fail to typecheck without the new field. Add `unattendedRun: row.unattendedRun,` after `hasActionableProposedPlan: row.hasActionableProposedPlan > 0,` in BOTH builders.

- [ ] **Step 4: Write the failing ingestion test for top-level stamping.** Open `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` and find an existing test that feeds an `item.completed` (or `item.started`) subagent-child runtime event and asserts the dispatched `thread.activity.append` activity. Add a test asserting the dispatched activity now carries TOP-LEVEL `itemId` and `parentItemId` (not just inside `payload`). Mirror the file's existing harness exactly (same `it.layer` / dispatch-capture setup the other tests use). The assertion core:

  ```ts
  // after capturing the dispatched activity-append command for a subagent-child event:
  assert.strictEqual(appendedActivity.parentItemId, "item-root-1");
  assert.strictEqual(appendedActivity.itemId, "item-child-1");
  ```

  Run it — it MUST FAIL (the top-level fields are not stamped yet):

  ```bash
  pnpm --filter t3 test ProviderRuntimeIngestion
  ```

  Expected: FAIL.

- [ ] **Step 5: Stamp the top-level fields at dispatch.** The cleanest single-point change is a post-map step in the dispatch loop (lines 1698-1711), so every activity from every `case` branch gets stamped uniformly from data already in `payload` plus the in-scope `thread`. The `thread` shell is resolved at line 711 (`resolveThreadShell`) and is in scope at the dispatch loop. Replace the dispatch block:

  ```ts
  const activities = runtimeEventToActivities(event);
  yield *
    Effect.forEach(activities, (activity) =>
      providerCommandId(event, "thread-activity-append").pipe(
        Effect.flatMap((commandId) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: thread.id,
            activity,
            createdAt: activity.createdAt,
          }),
        ),
      ),
    ).pipe(Effect.asVoid);
  ```

  with a version that lifts `itemId`/`parentItemId` out of the activity payload to the top level and stamps `iteration` from the thread's running unattended iteration:

  ```ts
  const currentIteration = thread.unattendedRun?.currentIteration;
  const activities = runtimeEventToActivities(event).map((activity) => {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const payloadItemId =
      typeof payload?.itemId === "string" ? RuntimeItemId.make(payload.itemId) : undefined;
    const payloadParentItemId =
      typeof payload?.parentItemId === "string"
        ? RuntimeItemId.make(payload.parentItemId)
        : undefined;
    return {
      ...activity,
      ...(payloadItemId !== undefined ? { itemId: payloadItemId } : {}),
      ...(payloadParentItemId !== undefined ? { parentItemId: payloadParentItemId } : {}),
      ...(payloadParentItemId !== undefined && currentIteration !== undefined
        ? { iteration: currentIteration }
        : {}),
    };
  });
  yield *
    Effect.forEach(activities, (activity) =>
      providerCommandId(event, "thread-activity-append").pipe(
        Effect.flatMap((commandId) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: thread.id,
            activity,
            createdAt: activity.createdAt,
          }),
        ),
      ),
    ).pipe(Effect.asVoid);
  ```

  > `iteration` is stamped only on subagent-child activities (those with a `parentItemId`), matching the design: the iteration active at the time a subagent runs is recorded on its transcript rows. Root `collab_agent_tool_call` refs (no `parentItemId`) keep `iteration` absent at this layer; Phase 2 derives a ref's iteration from its children if needed.
  > Ensure `RuntimeItemId` is imported from `@t3tools/contracts` at the top of `ProviderRuntimeIngestion.ts`; add it to the existing contracts import if missing.

- [ ] **Step 6: Re-run the ingestion test — it MUST PASS.**

  ```bash
  pnpm --filter t3 test ProviderRuntimeIngestion
  ```

  Expected: PASS.

- [ ] **Step 7: Typecheck contracts and server.**

  ```bash
  cd packages/contracts && npx tsgo --noEmit
  cd ../../apps/server && npx tsgo --noEmit
  ```

  Expected: no errors in either.

- [ ] **Step 8: Commit.**
  ```bash
  git add packages/contracts/src/orchestration.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
  git commit -m "feat(server): stamp top-level itemId/parentItemId/iteration on ingested subagent activities"
  ```

---

## Task 6: ProjectionPipeline upsert carries itemId/parentItemId/iteration

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (`applyThreadActivitiesProjection` `thread.activity-appended` case lines 966-980)
- Test: `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`

- [ ] **Step 1: Write the failing pipeline test.** In `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`, mirror an existing `thread.activity-appended` pipeline test. Feed an activity-appended event whose `activity` carries top-level `itemId`/`parentItemId`/`iteration`, then read it back via the activity repository (`projectionThreadActivityRepository.listByThreadId`) and assert the persisted row carries those fields. Assertion core:

  ```ts
  const childRow = rows.find((r) => r.activityId === "activity-sub-1");
  assert.strictEqual(childRow?.parentItemId, "item-root-1");
  assert.strictEqual(childRow?.itemId, "item-child-1");
  assert.strictEqual(childRow?.iteration, 2);
  ```

  Run it — it MUST FAIL (the pipeline drops the fields today):

  ```bash
  pnpm --filter t3 test ProjectionPipeline
  ```

  Expected: FAIL.

- [ ] **Step 2: Carry the fields through the upsert.** Replace the `thread.activity-appended` case in `applyThreadActivitiesProjection` (lines 966-980):

  ```ts
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;
  ```

  with:

  ```ts
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            ...(event.payload.activity.itemId !== undefined
              ? { itemId: event.payload.activity.itemId }
              : {}),
            ...(event.payload.activity.parentItemId !== undefined
              ? { parentItemId: event.payload.activity.parentItemId }
              : {}),
            ...(event.payload.activity.iteration !== undefined
              ? { iteration: event.payload.activity.iteration }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;
  ```

- [ ] **Step 3: Re-run the pipeline test — it MUST PASS.**

  ```bash
  pnpm --filter t3 test ProjectionPipeline
  ```

  Expected: PASS.

- [ ] **Step 4: Typecheck the server package.**

  ```bash
  cd apps/server && npx tsgo --noEmit
  ```

  Expected: no errors.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/server/src/orchestration/Layers/ProjectionPipeline.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts
  git commit -m "feat(server): carry subagent classification through the activity projection upsert"
  ```

---

## Task 7: In-memory projector excludes parentItemId-bearing activities

**Files:**

- Modify: `apps/server/src/orchestration/projector.ts` (`thread.activity-appended` reducer lines 668-696)
- Test: `apps/server/src/orchestration/projector.test.ts` (mirror the activity-appended test at lines 575-594)

- [ ] **Step 1: Write the failing projector test.** Append to the `describe("orchestration projector", ...)` block in `apps/server/src/orchestration/projector.test.ts`. It applies `thread.created`, then two `thread.activity-appended` events — one normal, one subagent-child (top-level `parentItemId`) — and asserts only the normal one lands in `thread.activities`. Use the file's `makeEvent` helper and `createEmptyReadModel`/`projectEvent` already imported (lines 12, 14):

  ```ts
  it("excludes subagent-child activities (parentItemId set) from thread.activities", async () => {
    const now = "2026-06-20T00:00:00.000Z";
    let model = createEmptyReadModel(now);

    model = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: { provider: "claude", model: "sonnet" },
            runtimeMode: "collab",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    model = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 2,
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-06-20T00:00:01.000Z",
          commandId: "cmd-activity-normal",
          payload: {
            threadId: "thread-1",
            activity: {
              id: "activity-normal",
              tone: "tool",
              kind: "tool.started",
              summary: "Edit file started",
              payload: { itemType: "command" },
              turnId: "turn-1",
              createdAt: "2026-06-20T00:00:01.000Z",
            },
          },
        }),
      ),
    );

    model = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 3,
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-06-20T00:00:02.000Z",
          commandId: "cmd-activity-subagent",
          payload: {
            threadId: "thread-1",
            activity: {
              id: "activity-subagent-child",
              tone: "info",
              kind: "tool.completed",
              summary: "Subagent message",
              payload: { itemType: "assistant_message", status: "completed" },
              turnId: "turn-1",
              itemId: "item-child-1",
              parentItemId: "item-root-1",
              iteration: 1,
              createdAt: "2026-06-20T00:00:02.000Z",
            },
          },
        }),
      ),
    );

    const thread = model.threads[0];
    const ids = thread?.activities.map((activity) => activity.id) ?? [];
    expect(ids).toContain("activity-normal");
    expect(ids).not.toContain("activity-subagent-child");
  });
  ```

  Adjust the `modelSelection`/`runtimeMode`/`interactionMode` literals in the `thread.created` payload to match exactly what the other `thread.created` tests in this file use (read lines 56-95) so decoding succeeds. Run it — it MUST FAIL (the child currently gets pushed):

  ```bash
  pnpm --filter t3 test projector
  ```

  Expected: FAIL (`activity-subagent-child` is present in `thread.activities`).

- [ ] **Step 2: Skip parentItemId-bearing activities in the reducer.** Replace the `thread.activity-appended` case (lines 668-696):

  ```ts
    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );
  ```

  with (subagent-child activities — those carrying `parentItemId` — are kept OUT of the in-memory parent list so the 500-cap holds real messages; the thread's `updatedAt` still advances):

  ```ts
    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          if (payload.activity.parentItemId !== undefined) {
            return {
              ...nextBase,
              threads: updateThread(nextBase.threads, payload.threadId, {
                updatedAt: event.occurredAt,
              }),
            };
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );
  ```

- [ ] **Step 3: Re-run the projector test — it MUST PASS.**

  ```bash
  pnpm --filter t3 test projector
  ```

  Expected: PASS (new test green; existing projector tests still green — none of them set `parentItemId`).

- [ ] **Step 4: Typecheck the server package.**

  ```bash
  cd apps/server && npx tsgo --noEmit
  ```

  Expected: no errors.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/server/src/orchestration/projector.ts apps/server/src/orchestration/projector.test.ts
  git commit -m "feat(server): exclude subagent-child activities from the in-memory projector thread list"
  ```

---

## Task 8: has_subagents / live_subagent_count on projection_threads

**Files:**

- Create: `apps/server/src/persistence/Migrations/035_ProjectionThreadsSubagentCounts.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/persistence/Services/ProjectionThreads.ts` (struct lines 27-46)
- Modify: `apps/server/src/persistence/Layers/ProjectionThreads.ts` (DbRow lines 19-24; INSERT lines 30-94; the two SELECTs lines 96-153)
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (`ProjectionThreadDbRowSchema` lines 78-83; the four thread-row SELECTs `listThreadRows` ~320, `listActiveThreadRows` ~349, `listArchivedThreadRows` ~380, `getActiveThreadRowById` ~743; three shell builders lines 1510-1528, 1643-1662, 1884-1902)
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` (`refreshThreadShellSummary` lines 548-591; `thread.created` upsert lines 597-617)
- Modify: `packages/contracts/src/orchestration.ts` (`OrchestrationThreadShell` lines 425-446)

- [ ] **Step 1: Create migration 035.** Write `apps/server/src/persistence/Migrations/035_ProjectionThreadsSubagentCounts.ts`, PRAGMA-guarded, adding both NOT NULL DEFAULT 0 columns:

  ```ts
  import * as SqlClient from "effect/unstable/sql/SqlClient";
  import * as Effect from "effect/Effect";

  export default Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_threads)
    `;

    if (!columns.some((column) => column.name === "has_subagents")) {
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN has_subagents INTEGER NOT NULL DEFAULT 0
      `;
    }

    if (!columns.some((column) => column.name === "live_subagent_count")) {
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN live_subagent_count INTEGER NOT NULL DEFAULT 0
      `;
    }

    yield* sql`
      UPDATE projection_threads
      SET has_subagents = 1
      WHERE has_subagents = 0
        AND EXISTS (
          SELECT 1
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = projection_threads.thread_id
            AND activity.parent_item_id IS NULL
            AND json_extract(activity.payload_json, '$.itemType') = 'collab_agent_tool_call'
        )
    `;
  });
  ```

  > `live_subagent_count` is left at its default 0 on backfill (no running subagents survive a restart); `has_subagents` is sticky-true and backfilled from existing root refs.

- [ ] **Step 2: Register migration 035.** In `apps/server/src/persistence/Migrations.ts`, add after the `Migration0034` import:

  ```ts
  import Migration0035 from "./Migrations/035_ProjectionThreadsSubagentCounts.ts";
  ```

  and after the `[34, ...]` tuple:

  ```ts
    [34, "ProjectionThreadActivitiesSubagentColumns", Migration0034],
    [35, "ProjectionThreadsSubagentCounts", Migration0035],
  ] as const;
  ```

- [ ] **Step 3: Add the two count fields to the persistence service struct.** In `apps/server/src/persistence/Services/ProjectionThreads.ts`, in the `ProjectionThread` struct (lines 27-46), add after `hasActionableProposedPlan`:

  ```ts
    hasActionableProposedPlan: NonNegativeInt,
    hasSubagents: NonNegativeInt,
    liveSubagentCount: NonNegativeInt,
  ```

  (`NonNegativeInt` is already imported.)

- [ ] **Step 4: Extend the persistence write layer for the two columns.** In `apps/server/src/persistence/Layers/ProjectionThreads.ts`:
  - INSERT column list (after `has_actionable_proposed_plan,`):
    ```ts
          has_actionable_proposed_plan,
          has_subagents,
          live_subagent_count,
    ```
  - INSERT VALUES (after `${row.hasActionableProposedPlan},`):
    ```ts
          ${row.hasActionableProposedPlan},
          ${row.hasSubagents},
          ${row.liveSubagentCount},
    ```
  - ON CONFLICT DO UPDATE (after `has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,`):
    ```ts
          has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
          has_subagents = excluded.has_subagents,
          live_subagent_count = excluded.live_subagent_count,
    ```
  - BOTH SELECTs (`getProjectionThreadRow` lines 100-122 and `listProjectionThreadRows` lines 129-152), after `has_actionable_proposed_plan AS "hasActionableProposedPlan",`:
    ```ts
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          has_subagents AS "hasSubagents",
          live_subagent_count AS "liveSubagentCount",
    ```

- [ ] **Step 5: Extend the read-side row schema + the four thread-row SELECTs in ProjectionSnapshotQuery.** In `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`:
  - The `ProjectionThreadDbRowSchema` (lines 78-83) is `ProjectionThread.mapFields(...)` over the persistence `ProjectionThread` schema — it inherits the two new `NonNegativeInt` fields automatically, no change needed there. Verify the import of `ProjectionThread` is the persistence-service one (it is).
  - Add `has_subagents AS "hasSubagents",` and `live_subagent_count AS "liveSubagentCount",` to the column list of ALL FOUR queries: `listThreadRows` (after line 341), `listActiveThreadRows` (after line 370), `listArchivedThreadRows` (after line 401), and `getActiveThreadRowById` (after line 764). Place them right after `has_actionable_proposed_plan AS "hasActionableProposedPlan",` in each.

- [ ] **Step 6: Add the two fields to `OrchestrationThreadShell` contract.** In `packages/contracts/src/orchestration.ts`, in the struct at lines 425-446 (alongside the `unattendedRun` added in Task 5), add:

  ```ts
    hasSubagents: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    liveSubagentCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  ```

  (`NonNegativeInt` is already imported in this file.)

- [ ] **Step 7: Surface the two fields in the three shell builders.** In `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, in all three places that build `OrchestrationThreadShell`:
  - `getShellSnapshot` (lines 1510-1528): after `hasActionableProposedPlan: row.hasActionableProposedPlan > 0,` add:
    ```ts
                    hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                    hasSubagents: row.hasSubagents > 0,
                    liveSubagentCount: row.liveSubagentCount,
    ```
  - `getArchivedShellSnapshot` (lines 1643-1662): same two lines after `hasActionableProposedPlan: row.hasActionableProposedPlan > 0,`.
  - `getThreadShellById` (lines 1884-1902): same two lines, sourced from `threadRow.value`:
    ```ts
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
        hasSubagents: threadRow.value.hasSubagents > 0,
        liveSubagentCount: threadRow.value.liveSubagentCount,
    ```
    (These are in addition to the `unattendedRun` lines from Task 5 Steps 2-3.)

- [ ] **Step 8: Maintain the counts in `refreshThreadShellSummary` (the pendingApprovalCount precedent).** In `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `refreshThreadShellSummary` (lines 548-591) already loads `activities` for the thread. Add a derivation helper near `derivePendingUserInputCountFromActivities` (after line 178):

  ```ts
  function deriveSubagentCounts(activities: ReadonlyArray<ProjectionThreadActivity>): {
    readonly hasSubagents: boolean;
    readonly liveSubagentCount: number;
  } {
    const runningRootItemIds = new Set<string>();
    let sawAnyRoot = false;

    const ordered = [...activities].toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.activityId.localeCompare(right.activityId),
    );

    for (const activity of ordered) {
      if (activity.parentItemId !== undefined) {
        continue;
      }
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as Record<string, unknown>)
          : null;
      if (payload?.itemType !== "collab_agent_tool_call") {
        continue;
      }
      const rootItemId = activity.itemId;
      if (rootItemId === undefined) {
        continue;
      }
      sawAnyRoot = true;
      if (activity.kind === "tool.completed") {
        runningRootItemIds.delete(rootItemId);
      } else {
        runningRootItemIds.add(rootItemId);
      }
    }

    return {
      hasSubagents: sawAnyRoot,
      liveSubagentCount: runningRootItemIds.size,
    };
  }
  ```

  Then in `refreshThreadShellSummary`, after `const hasActionableProposedPlan = deriveHasActionableProposedPlan({...});` (line 582), add:

  ```ts
  const subagentCounts = deriveSubagentCounts(activities);
  ```

  and extend the final upsert (lines 584-590) to carry the two columns, preserving sticky-true `has_subagents` from the existing row:

  ```ts
  yield *
    projectionThreadRepository.upsert({
      ...existingRow.value,
      latestUserMessageAt,
      pendingApprovalCount,
      pendingUserInputCount,
      hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
      hasSubagents: existingRow.value.hasSubagents > 0 || subagentCounts.hasSubagents ? 1 : 0,
      liveSubagentCount: subagentCounts.liveSubagentCount,
    });
  ```

  > `has_subagents` is sticky-true: once a thread has ever had a subagent root ref it stays flagged. `live_subagent_count` reflects the current count of running first-level subagents (root refs whose latest lifecycle is not `tool.completed`).

- [ ] **Step 9: Initialize the counts on `thread.created`.** In `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, the `thread.created` upsert (lines 598-617) must supply the two new required fields. Add after `hasActionableProposedPlan: 0,`:

  ```ts
            hasActionableProposedPlan: 0,
            hasSubagents: 0,
            liveSubagentCount: 0,
  ```

  > Search the file for every other `projectionThreadRepository.upsert({` call that builds a full row literal (rather than spreading `...existingRow.value`) and add the two fields there too. The spread-based upserts (`...existingRow.value`) inherit the columns automatically and need no change. Confirm with:

  ```bash
  grep -n "projectionThreadRepository.upsert" apps/server/src/orchestration/Layers/ProjectionPipeline.ts
  ```

- [ ] **Step 10: Update any other full-row constructors of the persistence `ProjectionThread`.** Search the whole server for places that build the persistence `ProjectionThread` literal (not via `...existingRow.value`) so they include the two fields:

  ```bash
  grep -rn "hasActionableProposedPlan" apps/server/src --include=*.ts | grep -v test
  ```

  For any non-spread literal, add `hasSubagents: 0, liveSubagentCount: 0,` (or the appropriate computed value). Test fixtures that build the row literal must also be updated (they will fail to typecheck otherwise).

- [ ] **Step 11: Typecheck contracts and server.**

  ```bash
  cd packages/contracts && npx tsgo --noEmit
  cd ../../apps/server && npx tsgo --noEmit
  ```

  Expected: no errors. (If server reports a missing field on a `ProjectionThread` literal, you missed a constructor in Step 10 — add the two fields there.)

- [ ] **Step 12: Run the pipeline + snapshot tests.**

  ```bash
  pnpm --filter t3 test ProjectionPipeline
  pnpm --filter t3 test ProjectionSnapshotQuery
  ```

  Expected: PASS.

- [ ] **Step 13: Commit.**
  ```bash
  git add apps/server/src/persistence/Migrations/035_ProjectionThreadsSubagentCounts.ts apps/server/src/persistence/Migrations.ts apps/server/src/persistence/Services/ProjectionThreads.ts apps/server/src/persistence/Layers/ProjectionThreads.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts apps/server/src/orchestration/Layers/ProjectionPipeline.ts packages/contracts/src/orchestration.ts
  git commit -m "feat(server): maintain has_subagents/live_subagent_count summary counts on projection_threads"
  ```

---

## Task 9: Phase verification — snapshot excludes subagent children; counts reflect running subagents

**Files:**

- Test: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` (mirror the harness at lines 1-90: `it.layer` over `OrchestrationProjectionSnapshotQueryLive` + `SqlitePersistenceMemory`, raw `sql` INSERTs)

- [ ] **Step 1: Add an end-to-end snapshot exclusion test.** Inside the `projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {...})` block, add a test that: inserts a project + thread, inserts a top-level `collab_agent_tool_call` root ref (`parent_item_id` NULL, `item_id = 'item-root-1'`), inserts a subagent-child activity (`parent_item_id = 'item-root-1'`), then calls `getThreadDetailById` and asserts the child is absent while the root ref is present. Use the raw-SQL insert style already in the file (read lines 48-90 for the exact INSERT shape; the `projection_thread_activities` table now has `item_id`, `parent_item_id`, `iteration` columns). Core of the test:

  ```ts
  it.effect("excludes subagent-child activities from the thread-detail snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, item_id, parent_item_id, iteration, created_at
        ) VALUES (
          'activity-root-ref', 'thread-1', 'turn-1', 'tool', 'tool.started',
          'Task started',
          '{"itemType":"collab_agent_tool_call","itemId":"item-root-1"}',
          1, 'item-root-1', NULL, NULL, '2026-06-20T00:00:01.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, item_id, parent_item_id, iteration, created_at
        ) VALUES (
          'activity-subagent-child', 'thread-1', 'turn-1', 'info', 'tool.completed',
          'Subagent message',
          '{"itemType":"assistant_message","status":"completed","parentItemId":"item-root-1","itemId":"item-child-1"}',
          2, 'item-child-1', 'item-root-1', 1, '2026-06-20T00:00:02.000Z'
        )
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.strictEqual(detail._tag, "Some");
      const ids = detail._tag === "Some" ? detail.value.activities.map((a) => a.id) : [];
      assert.ok(ids.includes("activity-root-ref"));
      assert.ok(!ids.includes("activity-subagent-child"));
    }),
  );
  ```

  The `thread-1`/`project-1` rows are inserted by the file's first test fixture; if test isolation requires it, insert the project+thread rows at the top of this test the same way the first test does (read lines 48-130 for the exact column lists, including the new `has_subagents` / `live_subagent_count` columns — provide `0` for both). Run:

  ```bash
  pnpm --filter t3 test ProjectionSnapshotQuery
  ```

  Expected: PASS.

- [ ] **Step 2: Add the direct-children + root-ref query assertions.** In the same test (or an adjacent one sharing the inserted rows), assert the new queries behave:

  ```ts
  const children =
    yield *
    snapshotQuery.listSubagentChildActivityRows({
      threadId: ThreadId.make("thread-1"),
      parentItemId: RuntimeItemId.make("item-root-1"),
    });
  assert.strictEqual(children.length, 1);
  assert.strictEqual(children[0]?.id, "activity-subagent-child");

  const roots =
    yield *
    snapshotQuery.listSubagentRootRefRows({
      threadId: ThreadId.make("thread-1"),
    });
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0]?.id, "activity-root-ref");
  ```

  Add `RuntimeItemId` to the `@t3tools/contracts` import at the top of the test file. Run:

  ```bash
  pnpm --filter t3 test ProjectionSnapshotQuery
  ```

  Expected: PASS.

- [ ] **Step 3: Add a `live_subagent_count` pipeline assertion.** In `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`, add a test that drives the pipeline with: a `thread.created`, a root-ref `thread.activity-appended` (`tool.started`, `itemType: collab_agent_tool_call`, top-level `itemId: item-root-1`, no `parentItemId`), then reads the thread row back via `projectionThreadRepository.getById` and asserts `hasSubagents === 1` and `liveSubagentCount === 1`. Then drive a `tool.completed` root-ref append for the same `item-root-1` and assert `liveSubagentCount === 0` while `hasSubagents` stays `1`. Mirror the existing pipeline-test harness in that file (the `it.layer` + dispatch/apply setup the other tests use). Run:

  ```bash
  pnpm --filter t3 test ProjectionPipeline
  ```

  Expected: PASS.

- [ ] **Step 4: Full server test sweep + typecheck.**

  ```bash
  pnpm --filter t3 test
  cd apps/server && npx tsgo --noEmit
  ```

  Expected: all PASS, no type errors.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts
  git commit -m "test(server): verify subagent snapshot exclusion and live_subagent_count maintenance"
  ```

---

## Phase 1 self-check

Before declaring Phase 1 complete, ALL of the following must be green:

- [ ] **Contracts typecheck + tests:**
  ```bash
  cd packages/contracts && npx tsgo --noEmit && cd -
  pnpm --filter @t3tools/contracts test orchestration
  ```
- [ ] **Server typecheck + full test suite:**
  ```bash
  cd apps/server && npx tsgo --noEmit && cd -
  pnpm --filter t3 test
  ```
- [ ] **Repo gate (from `AGENTS.md`):** `vp check` and `vp run typecheck` must pass.
- [ ] **Lint:** `pnpm lint` passes.
- [ ] **Migrations apply cleanly forward:** booting any `SqlitePersistenceMemory`-backed test runs migrations 001→035 in order with no error (already exercised by the snapshot-query and pipeline tests).
- [ ] **Behavioral checks (asserted by tests, restate the intent):**
  - `getThreadDetailById` snapshot for a thread with subagent children returns only `parent_item_id IS NULL` activities — the root `collab_agent_tool_call` ref is present, its child transcript rows are absent.
  - `listSubagentChildActivityRows({ threadId, parentItemId })` returns exactly the direct children of that root ref.
  - `listSubagentRootRefRows({ threadId })` returns exactly the top-level `collab_agent_tool_call` refs.
  - The in-memory projector keeps subagent-child activities out of `thread.activities`.
  - `has_subagents` is sticky-true once any root ref exists; `live_subagent_count` reflects currently-running first-level subagents and returns to 0 when they complete.
- [ ] **Manual snapshot-size sanity check (optional but recommended):** on a thread that previously ran subagents, compare the `OrchestrationThreadDetailSnapshot` activity count before and after this change — the payload should drop by the number of subagent-child activities. Quick SQL sanity:
  ```sql
  SELECT
    (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ?) AS total,
    (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ? AND parent_item_id IS NULL) AS in_snapshot,
    (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ? AND parent_item_id IS NOT NULL) AS excluded_children;
  ```
  `in_snapshot + excluded_children == total`, and `in_snapshot` is what `subscribeThread` now ships.

> **Phase 2 dependency note:** Phase 2 (server read APIs — `subscribeSubagentTree` / `subscribeSubagent`) builds directly on the locked surface added here: the `item_id`/`parent_item_id`/`iteration` columns, the `idx_projection_thread_activities_thread_parent_created` index, the `has_subagents`/`live_subagent_count` columns, and the `listSubagentChildActivityRows` / `listSubagentRootRefRows` query methods. Do not rename these in later phases.
