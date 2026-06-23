import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // Marks a thread as a cross-provider subagent (spawned via the `spawn_agent` MCP
  // tool), pointing at its spawning parent thread. Such threads are hidden from the
  // top-level shell snapshot and surfaced only through the parent's subagent tree.
  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }
});
