/** Sentinel the agent prints on its own line after wrapping an iteration. */
export const WRAP_SENTINEL = "<<T3_WRAP_COMPLETE>>";

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
    `If you instead need a human decision, STOP and ask your question WITHOUT the`,
    `sentinel line — the run will pause for me.`,
  ].join("\n");

/** Message sent for iterations 2..N after the context is cleared. */
export const CONTINUE_MESSAGE =
  "continue — read the latest handoff document and resume the unattended run.";
