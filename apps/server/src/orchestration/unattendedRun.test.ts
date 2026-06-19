import { describe, expect, it } from "vite-plus/test";

import {
  buildContextClearedSummary,
  buildContextFreshSummary,
  buildUnattendedPreamble,
  CONTINUE_MESSAGE,
  CONTEXT_CLEARED_ACTIVITY_KIND,
  CONTEXT_FRESH_ACTIVITY_KIND,
  messageHasWrapSentinel,
  WRAP_SENTINEL,
} from "./unattendedRun.ts";

describe("unattended run constants", () => {
  it("detects the sentinel on its own line", () => {
    expect(messageHasWrapSentinel(`done\n${WRAP_SENTINEL}`)).toBe(true);
    expect(messageHasWrapSentinel(`${WRAP_SENTINEL}\n`)).toBe(true);
  });

  it("does not treat an unrelated message as a wrap", () => {
    expect(messageHasWrapSentinel("still thinking, here is a question?")).toBe(false);
    expect(messageHasWrapSentinel("")).toBe(false);
  });

  it("preamble mentions the iteration count and the sentinel", () => {
    const preamble = buildUnattendedPreamble(5);
    expect(preamble).toContain("5");
    expect(preamble).toContain(WRAP_SENTINEL);
  });

  it("preamble states a ~35% wrap-budget ceiling", () => {
    const preamble = buildUnattendedPreamble(5);
    expect(preamble).toContain("35%");
    expect(preamble.toLowerCase()).toContain("ceiling");
  });

  it("has a non-empty continue message", () => {
    expect(CONTINUE_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("context-clear marker formatting", () => {
  it("exposes the two marker kinds", () => {
    expect(CONTEXT_CLEARED_ACTIVITY_KIND).toBe("unattended.context-cleared");
    expect(CONTEXT_FRESH_ACTIVITY_KIND).toBe("unattended.context-fresh");
  });

  it("formats a cleared marker with before-usage and percentage", () => {
    expect(
      buildContextClearedSummary({
        fromIteration: 4,
        toIteration: 5,
        usedTokens: 517_000,
        maxTokens: 1_000_000,
      }),
    ).toBe("Context cleared · iteration 4 → 5 · before 517k / 1M (52%)");
  });

  it("formats a fresh marker with the new usage and a sub-1% percentage", () => {
    expect(
      buildContextFreshSummary({ iteration: 5, usedTokens: 4_000, maxTokens: 1_000_000 }),
    ).toBe("Fresh context · iteration 5 · now 4k / 1M (0.4%)");
  });

  it("handles unknown usage on the cleared marker", () => {
    expect(buildContextClearedSummary({ fromIteration: 1, toIteration: 2 })).toBe(
      "Context cleared · iteration 1 → 2 · before usage unknown",
    );
  });
});
