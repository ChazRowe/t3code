import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectionThreadsSubagentCounts", (it) => {
  it.effect(
    "backfills has_subagents for threads that have a root collab_agent_tool_call activity",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Run migrations up through 034 (before has_subagents column exists).
        yield* runMigrations({ toMigrationInclusive: 34 });

        // Thread that HAS a root-level collab_agent_tool_call activity — should get has_subagents=1.
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
          'thread-with-subagent',
          'project-1',
          'Thread With Subagent',
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

        // Thread with NO subagent activity — should keep has_subagents=0.
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
          'thread-no-subagent',
          'project-1',
          'Thread No Subagent',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          NULL,
          NULL,
          'turn-2',
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

        // Root-level collab_agent_tool_call for thread-with-subagent (parent_item_id IS NULL).
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          parent_item_id,
          item_id,
          sequence,
          created_at
        )
        VALUES (
          'activity-collab-root',
          'thread-with-subagent',
          'turn-1',
          'info',
          'collab_agent_tool_call',
          'Subagent launched',
          '{"itemType":"collab_agent_tool_call","status":"running"}',
          NULL,
          'item-collab-1',
          NULL,
          '2026-06-01T00:01:00.000Z'
        )
      `;

        // A non-root activity (parent_item_id IS NOT NULL) — should NOT trigger backfill.
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          parent_item_id,
          item_id,
          sequence,
          created_at
        )
        VALUES (
          'activity-child-command',
          'thread-no-subagent',
          'turn-2',
          'info',
          'command_execution',
          'Child command',
          '{"itemType":"command_execution","status":"completed","title":"ls"}',
          'item-parent',
          'item-child',
          NULL,
          '2026-06-01T00:02:00.000Z'
        )
      `;

        // Run migration 035 — adds has_subagents/live_subagent_count and backfills.
        yield* runMigrations({ toMigrationInclusive: 35 });

        const rows = yield* sql<{
          readonly threadId: string;
          readonly hasSubagents: number;
        }>`
        SELECT
          thread_id AS "threadId",
          has_subagents AS "hasSubagents"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

        assert.deepStrictEqual(rows, [
          {
            threadId: "thread-no-subagent",
            hasSubagents: 0,
          },
          {
            threadId: "thread-with-subagent",
            hasSubagents: 1,
          },
        ]);
      }),
  );
});
