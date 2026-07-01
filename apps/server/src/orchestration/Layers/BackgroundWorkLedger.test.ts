import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BackgroundWorkLedger } from "../Services/BackgroundWorkLedger.ts";
import { makeBackgroundWorkLedgerLive } from "./BackgroundWorkLedger.ts";

const threadId = ThreadId.make("thread-ledger");
const iso = (s: string) => IsoDateTime.make(s);

describe("BackgroundWorkLedger", () => {
  let runtime: ManagedRuntime.ManagedRuntime<BackgroundWorkLedger, never> | null = null;

  afterEach(async () => {
    if (runtime) await runtime.dispose();
    runtime = null;
  });

  const start = (options?: { backstopMs?: number; sweepIntervalMs?: number }) => {
    runtime = ManagedRuntime.make(makeBackgroundWorkLedgerLive(options));
    return runtime;
  };

  it("counts entries and reports the oldest startedAt", async () => {
    const rt = start();
    const snap = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:02.000Z") });
        yield* ledger.register(threadId, { key: "t2", kind: "workflow", startedAt: iso("2026-01-01T00:00:01.000Z") });
        return yield* ledger.snapshotFor(threadId);
      }),
    );
    expect(snap).toEqual({ count: 2, oldestStartedAt: "2026-01-01T00:00:01.000Z" });
  });

  it("is idempotent on (threadId, key)", async () => {
    const rt = start();
    const snap = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:05.000Z") });
        yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:09.000Z") });
        return yield* ledger.snapshotFor(threadId);
      }),
    );
    expect(snap).toEqual({ count: 1, oldestStartedAt: "2026-01-01T00:00:05.000Z" });
  });

  it("returns null once the last entry is unregistered", async () => {
    const rt = start();
    const snap = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        yield* ledger.register(threadId, { key: "t1", kind: "subagent", startedAt: iso("2026-01-01T00:00:00.000Z") });
        yield* ledger.unregister(threadId, "t1");
        return yield* ledger.snapshotFor(threadId);
      }),
    );
    expect(snap).toBeNull();
  });

  it("clearThread drops every entry for the thread", async () => {
    const rt = start();
    const snap = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:00.000Z") });
        yield* ledger.register(threadId, { key: "t2", kind: "monitor", startedAt: iso("2026-01-01T00:00:00.000Z") });
        yield* ledger.clearThread(threadId);
        return yield* ledger.snapshotFor(threadId);
      }),
    );
    expect(snap).toBeNull();
  });

  it("publishes a change signal on register and unregister", async () => {
    const rt = start();
    const signals = await rt.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* BackgroundWorkLedger;
          const sub = yield* ledger.subscribeChanges;
          yield* ledger.register(threadId, { key: "t1", kind: "shell", startedAt: iso("2026-01-01T00:00:00.000Z") });
          const first = yield* PubSub.take(sub);
          yield* ledger.unregister(threadId, "t1");
          const second = yield* PubSub.take(sub);
          return [first, second];
        }),
      ),
    );
    expect(signals).toEqual([threadId, threadId]);
  });

  it("sweepBackstop expires entries older than the backstop and drops them", async () => {
    const rt = start({ backstopMs: 60 * 60 * 1000 }); // 1h
    const result = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        // startedAt far in the past → well beyond the 1h backstop from "now".
        yield* ledger.register(threadId, { key: "stale", kind: "shell", startedAt: iso("2020-01-01T00:00:00.000Z") });
        const expired = yield* ledger.sweepBackstop;
        const snap = yield* ledger.snapshotFor(threadId);
        return { expired, snap };
      }),
    );
    expect(result.expired).toEqual([threadId]);
    expect(result.snap).toBeNull();
  });

  it("sweepBackstop leaves fresh entries in place", async () => {
    const rt = start({ backstopMs: 60 * 60 * 1000 }); // 1h
    const result = await rt.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BackgroundWorkLedger;
        const freshStartedAt = iso(DateTime.formatIso(yield* DateTime.now));
        yield* ledger.register(threadId, { key: "fresh", kind: "shell", startedAt: freshStartedAt });
        const expired = yield* ledger.sweepBackstop;
        const snap = yield* ledger.snapshotFor(threadId);
        return { expired, snap, freshStartedAt };
      }),
    );
    expect(result.expired).toEqual([]);
    expect(result.snap).toEqual({ count: 1, oldestStartedAt: result.freshStartedAt });
  });
});
