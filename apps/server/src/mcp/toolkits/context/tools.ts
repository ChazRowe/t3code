import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

/**
 * `context_usage` — a no-argument tool that reports how full the calling session's
 * context window is, as a plain percentage string such as "20%" (or "unknown" when
 * no usage has been measured yet).
 */
export const ContextUsageTool = Tool.make("context_usage", {
  description:
    "Report what percentage of the current context window the calling session has " +
    'consumed, as a plain string such as "20%". Takes no arguments. Returns "unknown" ' +
    "if no usage has been measured yet.",
  success: Schema.String,
})
  .annotate(Tool.Title, "Get context window usage")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
