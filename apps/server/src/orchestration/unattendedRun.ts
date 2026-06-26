/** Sentinel the agent prints on its own line after wrapping an iteration. */
export const WRAP_SENTINEL = "<<WRAP_COMPLETE>>";

/** True when the agent's final message signals a completed wrap. */
export const messageHasWrapSentinel = (text: string): boolean =>
  text.includes(WRAP_SENTINEL);

/** Message that opens iteration 1 and sets the unattended contract. */
export const buildUnattendedPreamble = (totalIterations: number): string =>
  [
    `This is an UNATTENDED run of ${totalIterations} iteration(s). No human will`,
    `respond between iterations.`,
    ``,
    `Do as much as you can this context window. When you reach a good stopping`,
    `point, or your context is filling, invoke your wrap skill to write the`,
    `handoff document, then end your message with the line:`,
    ``,
    WRAP_SENTINEL,
    ``,
    `on its own line. Seeing that line, I will clear the context and send you a`,
    `"continue" so you can resume from the handoff.`,
    ``,
    `Treat about 35% of your context window as your wrap ceiling. When you cross`,
    `it, finish your current step, invoke your wrap skill, and emit the sentinel —`,
    `don't keep going to a "natural" stopping point. Wrapping early and often is`,
    `correct here.`,
    ``,
    `If you finish everything before iteration ${totalIterations}, write`,
    `"STATUS: COMPLETE" as the first line of the handoff and end WITHOUT the`,
    `sentinel. The run pauses there rather than spinning through empty iterations.`,
    ``,
    `If you instead need a human decision, STOP and ask your question WITHOUT the`,
    `sentinel line — the run will pause for me.`,
    ``,
    `Never end your turn just to wait on a background task you started (a review, a`,
    `subagent, a CI run): ending without the sentinel pauses the run. Either wait for`,
    `the result within this turn (poll or monitor it), or invoke your wrap skill and`,
    `emit the sentinel so the next iteration resumes and picks the result up.`,
  ].join("\n");

/** Message sent for iterations 2..N after the context is cleared. */
export const CONTINUE_MESSAGE =
  "continue — invoke your continue skill to re-orient from the handoff, then resume the unattended run without waiting for me.";

/** Activity kind for the marker emitted when an iteration's context is cleared. */
export const CONTEXT_CLEARED_ACTIVITY_KIND = "unattended.context-cleared";
/** Activity kind for the marker emitted when the fresh session first reports usage. */
export const CONTEXT_FRESH_ACTIVITY_KIND = "unattended.context-fresh";

/** Compact token count: 1_000_000 -> "1M", 517_000 -> "517k", 4_000 -> "4k". */
const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1))}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000)}k`
      : `${tokens}`;

/** Percentage of the window used; one decimal under 1%, whole numbers otherwise. */
const formatPercent = (usedTokens: number, maxTokens: number): string => {
  if (maxTokens <= 0) return "—";
  const pct = (usedTokens / maxTokens) * 100;
  return pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
};

const formatUsage = (
  prefix: string,
  usage: { usedTokens?: number; maxTokens?: number },
  unknownLabel: string,
): string =>
  usage.usedTokens !== undefined && usage.maxTokens !== undefined
    ? `${prefix} ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} (${formatPercent(usage.usedTokens, usage.maxTokens)})`
    : unknownLabel;

/** Human summary for the context-cleared marker. */
export const buildContextClearedSummary = (input: {
  fromIteration: number;
  toIteration: number;
  usedTokens?: number;
  maxTokens?: number;
}): string =>
  `Context cleared · iteration ${input.fromIteration} → ${input.toIteration} · ${formatUsage(
    "before",
    input,
    "before usage unknown",
  )}`;

/** Human summary for the fresh-context marker. */
export const buildContextFreshSummary = (input: {
  iteration: number;
  usedTokens?: number;
  maxTokens?: number;
}): string =>
  `Fresh context · iteration ${input.iteration} · ${formatUsage("now", input, "fresh session")}`;
