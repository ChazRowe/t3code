/**
 * True when a CUSTOM (non-empty) preamble does not mention the effective
 * sentinel. The reactor watches the sentinel; if the preamble never tells the
 * agent to emit it, the loop can never advance. Empty preamble => false (the
 * built-in, model-aware preamble already embeds the sentinel). Warning only;
 * never blocks saving.
 */
export const preambleMissingEffectiveSentinel = (
  preamble: string,
  effectiveSentinel: string,
): boolean => preamble.trim().length > 0 && !preamble.includes(effectiveSentinel);
