import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { BackgroundWorkLedger } from "../../orchestration/Services/BackgroundWorkLedger.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const backgroundWorkLedger = yield* BackgroundWorkLedger;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        // Fast path: a recent provider-level touch (sendTurn / startSession /
        // stopSession bump `lastSeenAt`) means the session is plainly active, so
        // skip the projection lookup entirely.
        if (now - lastSeenMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));

        // `lastSeenAt` only advances on provider-level operations (sendTurn /
        // startSession / stopSession). A synthetic turn — the live SDK query
        // auto-re-invoking the agent when a backgrounded `Workflow` completes —
        // is real activity but never bumps it, so a session that was driving
        // synthetic turns minutes ago still reads as idle since its last *real*
        // turn. The projection session's `updatedAt` DOES advance on every turn
        // lifecycle event (incl. synthetic), so use the later of the two as the
        // session's true last-activity time. Without this, the reaper tears a
        // session down seconds after its final synthetic turn — the moment the
        // background-work guard below stops covering it — orphaning in-flight
        // subagent work (the looping+ultracode reaper incident).
        const sessionUpdatedAtMs = thread?.session?.updatedAt
          ? Date.parse(thread.session.updatedAt)
          : Number.NaN;
        const lastActivityMs = Number.isNaN(sessionUpdatedAtMs)
          ? lastSeenMs
          : Math.max(lastSeenMs, sessionUpdatedAtMs);
        const idleDurationMs = now - lastActivityMs;
        if (idleDurationMs < inactivityThresholdMs) {
          yield* Effect.logDebug("provider.session.reaper.skipped-recent-synthetic-activity", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
            sessionUpdatedAt: thread?.session?.updatedAt,
            idleDurationMs,
          });
          continue;
        }

        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // A session with no active turn can still be hosting background work the agent
        // launched and is waiting on (a Workflow, backgrounded Bash/subagent, MCP
        // monitor, or spawn_agent child). `lastSeenAt` does not advance for that work,
        // so without this guard the reaper tears the session down, orphaning the work
        // and losing the completion that would re-invoke the agent.
        const backgroundWork = yield* backgroundWorkLedger.snapshotFor(binding.threadId);
        if (backgroundWork !== null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-pending-background-work", {
            threadId: binding.threadId,
            provider: binding.provider,
            backgroundWorkCount: backgroundWork.count,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
