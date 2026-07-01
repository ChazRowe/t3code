import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import {
  BackgroundWorkLedger,
  type BackgroundWorkEntry,
  type BackgroundWorkLedgerShape,
} from "../Services/BackgroundWorkLedger.ts";

/**
 * Generous reaper backstop (NOT a per-source TTL). Every source has a reliable
 * terminal, so entries are normally cleared by their completion event. This only
 * bounds the abnormal case (an interrupted turn whose task never emits its
 * terminal notification) so a stuck entry cannot pin a session live forever.
 * Deliberately far longer than any per-task timeout: a legitimate multi-hour
 * build or all-day monitor must not be dropped prematurely — the in-view wait
 * timer is the user's cue to interrupt.
 */
const DEFAULT_BACKSTOP_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface BackgroundWorkLedgerLiveOptions {
  readonly backstopMs?: number;
  readonly sweepIntervalMs?: number;
}

type ThreadEntries = ReadonlyMap<string, BackgroundWorkEntry>;
type LedgerState = ReadonlyMap<ThreadId, ThreadEntries>;

const makeBackgroundWorkLedger = (options?: BackgroundWorkLedgerLiveOptions) =>
  Effect.gen(function* () {
    const backstopMs = Math.max(1, options?.backstopMs ?? DEFAULT_BACKSTOP_MS);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const state = yield* Ref.make<LedgerState>(new Map());
    const changes = yield* PubSub.unbounded<ThreadId>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    const register: BackgroundWorkLedgerShape["register"] = (threadId, entry) =>
      Effect.gen(function* () {
        const changed = yield* Ref.modify(state, (map): [boolean, LedgerState] => {
          const existing = map.get(threadId);
          if (existing?.has(entry.key)) return [false, map];
          const next = new Map(map);
          const inner = new Map(existing ?? []);
          inner.set(entry.key, entry);
          next.set(threadId, inner);
          return [true, next];
        });
        if (changed) yield* PubSub.publish(changes, threadId);
      });

    const unregister: BackgroundWorkLedgerShape["unregister"] = (threadId, key) =>
      Effect.gen(function* () {
        const changed = yield* Ref.modify(state, (map): [boolean, LedgerState] => {
          const existing = map.get(threadId);
          if (!existing?.has(key)) return [false, map];
          const next = new Map(map);
          const inner = new Map(existing);
          inner.delete(key);
          if (inner.size === 0) next.delete(threadId);
          else next.set(threadId, inner);
          return [true, next];
        });
        if (changed) yield* PubSub.publish(changes, threadId);
      });

    const clearThread: BackgroundWorkLedgerShape["clearThread"] = (threadId) =>
      Effect.gen(function* () {
        const changed = yield* Ref.modify(state, (map): [boolean, LedgerState] => {
          if (!map.has(threadId)) return [false, map];
          const next = new Map(map);
          next.delete(threadId);
          return [true, next];
        });
        if (changed) yield* PubSub.publish(changes, threadId);
      });

    const snapshotFor: BackgroundWorkLedgerShape["snapshotFor"] = (threadId) =>
      Ref.get(state).pipe(
        Effect.map((map) => {
          const inner = map.get(threadId);
          if (!inner || inner.size === 0) return null;
          let oldest = null as null | BackgroundWorkEntry["startedAt"];
          for (const entry of inner.values()) {
            if (oldest === null || entry.startedAt < oldest) oldest = entry.startedAt;
          }
          // `oldest` is non-null because inner.size >= 1.
          return { count: inner.size, oldestStartedAt: oldest! };
        }),
      );

    const sweepBackstop: BackgroundWorkLedgerShape["sweepBackstop"] = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const affected = yield* Ref.modify(state, (map): [ReadonlyArray<ThreadId>, LedgerState] => {
        const changedThreads: ThreadId[] = [];
        let next: Map<ThreadId, ThreadEntries> | null = null;
        for (const [threadId, inner] of map) {
          let innerNext: Map<string, BackgroundWorkEntry> | null = null;
          for (const [key, entry] of inner) {
            if (nowMs - Date.parse(entry.startedAt) >= backstopMs) {
              innerNext ??= new Map(inner);
              innerNext.delete(key);
            }
          }
          if (innerNext) {
            next ??= new Map(map);
            changedThreads.push(threadId);
            if (innerNext.size === 0) next.delete(threadId);
            else next.set(threadId, innerNext);
          }
        }
        return [changedThreads, next ?? map];
      });
      yield* Effect.forEach(affected, (threadId) => PubSub.publish(changes, threadId), {
        discard: true,
      });
      return affected;
    });

    // Backstop sweep fiber, tied to this layer's scope. `sweepBackstop` cannot
    // fail (error channel `never`); guard only against defects.
    yield* Effect.forkScoped(
      sweepBackstop.pipe(
        Effect.catchDefect((defect: unknown) =>
          Effect.logWarning("background-work.ledger.sweep-defect", { defect }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
      ),
    );

    return {
      register,
      unregister,
      clearThread,
      snapshotFor,
      sweepBackstop,
      get changes() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    } satisfies BackgroundWorkLedgerShape;
  });

export const makeBackgroundWorkLedgerLive = (options?: BackgroundWorkLedgerLiveOptions) =>
  Layer.effect(BackgroundWorkLedger, makeBackgroundWorkLedger(options));

export const BackgroundWorkLedgerLive = makeBackgroundWorkLedgerLive();
