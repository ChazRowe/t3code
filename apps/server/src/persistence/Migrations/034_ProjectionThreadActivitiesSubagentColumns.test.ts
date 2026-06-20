import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_ProjectionThreadActivitiesSubagentColumns", (it) => {
  it.effect("backfills item_id and parent_item_id from payload_json", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Run migrations up through 033 (before the subagent-column migration).
      yield* runMigrations({ toMigrationInclusive: 33 });

      // Insert a thread to satisfy the foreign key.
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-06-01T00:00:00.000Z',
          '2026-06-01T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      // Activity WITH itemId and parentItemId in payload — should be backfilled.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-with-ids',
          'thread-1',
          'turn-1',
          'info',
          'command_execution',
          'Child command',
          '{"itemId":"item-abc","parentItemId":"item-root","itemType":"command_execution","status":"completed","title":"Child command"}',
          NULL,
          '2026-06-01T00:01:00.000Z'
        )
      `;

      // Activity WITHOUT itemId/parentItemId in payload — should stay NULL after backfill.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-without-ids',
          'thread-1',
          'turn-1',
          'info',
          'assistant_message',
          'Hello world',
          '{"itemType":"assistant_message","status":"completed","detail":"Hello world"}',
          NULL,
          '2026-06-01T00:02:00.000Z'
        )
      `;

      // Run migration 034 — adds columns and executes the backfill UPDATEs.
      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{
        readonly activityId: string;
        readonly itemId: string | null;
        readonly parentItemId: string | null;
      }>`
        SELECT
          activity_id AS "activityId",
          item_id AS "itemId",
          parent_item_id AS "parentItemId"
        FROM projection_thread_activities
        ORDER BY activity_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          activityId: "activity-with-ids",
          itemId: "item-abc",
          parentItemId: "item-root",
        },
        {
          activityId: "activity-without-ids",
          itemId: null,
          parentItemId: null,
        },
      ]);
    }),
  );
});
