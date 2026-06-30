import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import { isVSCode } from "../../env";

import { getVsCodePrimaryBearerToken } from "./vscodeBearerAuth";

export function resolvePrimaryEnvironmentRequestInit(init?: RequestInit): RequestInit {
  const bearerToken = isVSCode ? getVsCodePrimaryBearerToken() : null;
  const headers = new Headers(init?.headers);
  if (bearerToken) {
    headers.set("authorization", `Bearer ${bearerToken}`);
    return {
      ...init,
      credentials: "omit",
      headers,
    };
  }

  return {
    ...init,
    credentials: "include",
    headers,
  };
}

/** @deprecated Prefer {@link resolvePrimaryEnvironmentRequestInit} for VSCode bearer auth. */
export const primaryEnvironmentRequestInit = { credentials: "include" } as const;

export const withPrimaryEnvironmentRequestInit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(
      FetchHttpClient.RequestInit,
      resolvePrimaryEnvironmentRequestInit(undefined),
    ),
  );
