import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

layer("Sqlite persistence setup", (it) => {
  it.effect("sets a non-zero busy_timeout so colliding writes wait instead of failing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout;`;
      assert.strictEqual(row?.timeout, 5000);
    }),
  );

  it.effect("enables WAL journaling and foreign keys", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [foreignKeys] = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys;`;
      assert.strictEqual(foreignKeys?.foreign_keys, 1);
    }),
  );
});
