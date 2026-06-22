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
    "providerInstanceId, runs the prompt to completion, and returns the subagent's " +
    "final response as text. Blocks until the subagent finishes. Call list_agents " +
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
