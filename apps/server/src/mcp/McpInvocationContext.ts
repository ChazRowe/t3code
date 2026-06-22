import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { PreviewAutomationUnavailableError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "spawn";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  // How many `spawn_agent` hops deep this session is below the user's top-level
  // session: 0 for a session the user started, 1 for a subagent it spawned, and so
  // on. The `spawn_agent` handler rejects spawns past a max depth to bound recursion.
  readonly subagentDepth: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      message: `MCP credential does not grant the ${capability} capability.`,
    });
  }
  return invocation;
});
