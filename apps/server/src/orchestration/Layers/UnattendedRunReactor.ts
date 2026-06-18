import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  UnattendedRunReactor,
  type UnattendedRunReactorShape,
} from "../Services/UnattendedRunReactor.ts";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  // Per-thread accumulator of the latest assistant text (reset at turn start).
  const latestAssistantText = new Map<string, string>();

  const processEvent = (_event: OrchestrationEvent) => Effect.void; // filled in Task 13

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("unattended run reactor failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const start: UnattendedRunReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => worker.enqueue(event)),
    );
  });

  return { start, drain: worker.drain } satisfies UnattendedRunReactorShape;
});

export const UnattendedRunReactorLive = Layer.effect(UnattendedRunReactor, make);

// Re-exported for unit testing pure helpers added in Task 13.
export const __test = { /* populated in Task 13 */ };
