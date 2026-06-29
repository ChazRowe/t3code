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
    "Delegate a task to a subagent running on another configured provider (e.g. " +
    "Codex, Claude, Grok, Cursor, OpenCode). Starts a real session on the chosen " +
    "providerInstanceId and runs the prompt in the background. Does NOT block: it " +
    "returns immediately with an agentId. Poll for completion and the final response " +
    "with check_agent (about once a minute) using that agentId. Call list_agents " +
    "first to discover valid providerInstanceId values.",
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
    "Poll a subagent started with spawn_agent for completion. Pass the agentId that " +
    "spawn_agent returned. While the subagent is still working this reports that it is " +
    "still running — poll again after about a minute. Once the turn finishes it returns " +
    "the subagent's final response (or surfaces an error if the subagent failed).",
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
    "List the provider instances available to spawn as subagents via spawn_agent. " +
    "Returns each instance's providerInstanceId, provider kind, and display name.",
  success: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "List spawnable subagent providers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
