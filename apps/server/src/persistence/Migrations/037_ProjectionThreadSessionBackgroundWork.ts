import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;

  // Adds a nullable JSON-text column that caches the in-flight background-work
  // snapshot (count + oldest startedAt) produced by the BackgroundWorkLedger.
  // NULL = no pending background work for the session.
  if (!columns.some((column) => column.name === "background_work")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN background_work TEXT
    `;
  }
});
