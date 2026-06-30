import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

// Built with the production default timeouts (no idle/lifetime overrides) so we
// assert the real lifetime an unattended run relies on.
const makeDefaultRegistry = (now: () => number) =>
  McpSessionRegistry.__testing
    .make({ now })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

const DAY_MS = 24 * 60 * 60 * 1_000;

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("expires credentials after inactivity", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("default credentials survive multi-day unattended runs", () =>
  Effect.gen(function* () {
    let timestamp = 0;
    const registry = yield* makeDefaultRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Six days later, after a long quiet gap with no MCP tool calls, the
    // credential must still resolve — the default idle/lifetime caps used to
    // kill it (30 min idle, 8 h lifetime) and break the loop.
    timestamp = 6 * DAY_MS;
    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);

    // Past a week from issuance the absolute lifetime should have elapsed.
    timestamp = 8 * DAY_MS;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
