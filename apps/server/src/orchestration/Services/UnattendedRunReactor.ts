import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface UnattendedRunReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class UnattendedRunReactor extends Context.Service<
  UnattendedRunReactor,
  UnattendedRunReactorShape
>()("t3/orchestration/Services/UnattendedRunReactor") {}
