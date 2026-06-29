import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const SpawnAgentParameters = Schema.Struct({
  providerInstanceId: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  // Optional model override; defaults to the target instance's configured model.
  model: Schema.optional(TrimmedNonEmptyString),
  // Optional short label shown for the subagent node in the watch tree.
  description: Schema.optional(TrimmedNonEmptyString),
});
export type SpawnAgentParameters = typeof SpawnAgentParameters.Type;

export const SpawnAgentTool = Tool.make("spawn_agent", {
  description:
    "Delegate a prompt to a subagent on another provider (Codex, Claude, Grok, Cursor, " +
    "OpenCode). Runs in the background and returns an agentId immediately; the subagent's " +
    "result is delivered to you as a message when it finishes — you don't need to poll. " +
    "Call list_agents for valid providerInstanceId values.",
  parameters: SpawnAgentParameters,
  success: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Spawn a subagent on another provider")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const CheckAgentParameters = Schema.Struct({
  // The agentId returned by spawn_agent (the subagent's child thread id).
  agentId: TrimmedNonEmptyString,
});
export type CheckAgentParameters = typeof CheckAgentParameters.Type;

export const CheckAgentTool = Tool.make("check_agent", {
  description:
    "Check whether a spawned subagent is still running. Pass its agentId; returns its " +
    "status (and final result if finished). Results arrive automatically as a message, so " +
    "use this only to check liveness on demand.",
  parameters: CheckAgentParameters,
  success: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Check a spawned subagent's status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ListAgentsTool = Tool.make("list_agents", {
  description:
    "List provider instances you can spawn subagents on — each with its " +
    "providerInstanceId, provider kind, and name.",
  success: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "List spawnable subagent providers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
