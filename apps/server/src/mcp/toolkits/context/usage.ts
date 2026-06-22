import { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Activity kind under which token-usage snapshots are projected onto the timeline. */
const CONTEXT_WINDOW_ACTIVITY_KIND = "context-window.updated";

/** Sentinel returned when the calling thread has no usable usage measurement yet. */
const UNKNOWN = "unknown";

const decodeSnapshot = Schema.decodeUnknownOption(ThreadTokenUsageSnapshot);

/** Percentage of the window used; one decimal under 1%, whole numbers otherwise. */
export const formatContextPercent = (usedTokens: number, maxTokens: number): string => {
  if (maxTokens <= 0) return UNKNOWN;
  const pct = (usedTokens / maxTokens) * 100;
  return pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
};

/**
 * Resolve the calling thread's context-window consumption as a percentage string
 * (e.g. "20%") from its projected activity timeline, or "unknown" when no usable
 * snapshot has been recorded yet.
 *
 * Activities arrive in ascending sequence order, so the last `context-window.updated`
 * entry is the most recent measurement.
 */
export const resolveContextUsage = (
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): string => {
  let latest: unknown;
  let found = false;
  for (const activity of activities) {
    if (activity.kind === CONTEXT_WINDOW_ACTIVITY_KIND) {
      latest = activity.payload;
      found = true;
    }
  }
  if (!found) return UNKNOWN;

  const snapshot = decodeSnapshot(latest);
  if (Option.isNone(snapshot)) return UNKNOWN;

  const { maxTokens, usedTokens } = snapshot.value;
  if (maxTokens === undefined) return UNKNOWN;
  return formatContextPercent(usedTokens, maxTokens);
};
