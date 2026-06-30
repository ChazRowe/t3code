import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";
import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";
import {
  PrimaryEnvironmentHttpClient,
  primaryEnvironmentHttpClientLive,
} from "../environments/primary/httpClient";
import {
  primaryEnvironmentRequestInit,
  resolvePrimaryEnvironmentRequestInit,
} from "../environments/primary/requestInit";

import { browserCryptoLayer } from "../cloud/dpop";
import { webManagedRelayClientLayer } from "../cloud/managedRelayLayer";
import { resolveCloudPublicConfig, resolveRelayTracingConfig } from "../cloud/publicConfig";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relayUrl ?? "http://relay.invalid";
}

const isLoopbackFetchTarget = (input: RequestInfo | URL): boolean => {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
};

const readVsCodeBridgeFetch = (): typeof fetch | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }
  const bridge = window.vscodeBridge;
  return bridge?.fetch ? bridge.fetch.bind(bridge) : undefined;
};

const resolvedBrowserFetch: typeof fetch = (input, init) => {
  const bridgeFetch = readVsCodeBridgeFetch();
  if (bridgeFetch && isLoopbackFetchTarget(input)) {
    return bridgeFetch(input, init);
  }
  return globalThis.fetch(input, init);
};

const webHttpClientLayer = remoteHttpClientLayer(resolvedBrowserFetch);
const webRelayTracingLayer = makeRelayClientTracingLayer(resolveRelayTracingConfig(), {
  serviceName: "t3-web-relay-client",
  serviceVersion: import.meta.env.APP_VERSION,
  runtime: "browser",
  client: typeof window !== "undefined" && window.desktopBridge ? "desktop" : "web",
}).pipe(Layer.provide(webHttpClientLayer));

export const remoteHttpRuntime = ManagedRuntime.make(webHttpClientLayer);

const primaryFetch: typeof fetch = (input, init) => {
  const resolvedInit = resolvePrimaryEnvironmentRequestInit(init);
  const bridgeFetch = readVsCodeBridgeFetch();
  if (bridgeFetch) {
    return bridgeFetch(input, resolvedInit);
  }
  return globalThis.fetch(input, resolvedInit);
};

const primaryHttpRuntime = ManagedRuntime.make(
  primaryEnvironmentHttpClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer(primaryFetch),
        Layer.succeed(FetchHttpClient.RequestInit, primaryEnvironmentRequestInit),
        httpHeaderRedactionLayer,
      ),
    ),
  ),
);

export type PrimaryHttpEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient>,
) => Promise<A>;

const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (effect) =>
  primaryHttpRuntime.runPromise(effect);

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <A, E>(effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient>) =>
  primaryHttpRunner(effect);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

export const webRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    webHttpClientLayer,
    browserCryptoLayer,
    webManagedRelayClientLayer(configuredRelayUrl()).pipe(
      Layer.provide(Layer.mergeAll(webHttpClientLayer, browserCryptoLayer)),
      Layer.provideMerge(webRelayTracingLayer),
    ),
  ),
);
