import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadsParentThread", (it) => {
  it.effect("adds a nullable parent_thread_id column to projection_threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isFalse(before.some((c) => c.name === "parent_thread_id"));

      yield* runMigrations({ toMigrationInclusive: 36 });
      const after = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const column = after.find((c) => c.name === "parent_thread_id");
      assert.isDefined(column);
      // Nullable so existing (non-subagent) rows default to NULL.
      assert.strictEqual(column?.notnull, 0);
    }),
  );
});
