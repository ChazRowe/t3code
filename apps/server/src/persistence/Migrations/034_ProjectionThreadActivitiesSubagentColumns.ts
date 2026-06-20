import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
