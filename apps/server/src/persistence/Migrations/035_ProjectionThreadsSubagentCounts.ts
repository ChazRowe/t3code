import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
