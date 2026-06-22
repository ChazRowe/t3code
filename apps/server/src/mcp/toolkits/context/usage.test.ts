import { expect, it } from "@effect/vitest";

import { formatContextPercent, resolveContextUsage } from "./usage.ts";

const usage = (payload: unknown) => ({ kind: "context-window.updated", payload });

it("formatContextPercent renders whole-number percentages", () => {
  expect(formatContextPercent(40_000, 200_000)).toBe("20%");
  expect(formatContextPercent(200_000, 200_000)).toBe("100%");
});

it("formatContextPercent renders sub-1% with one decimal", () => {
  expect(formatContextPercent(1_000, 200_000)).toBe("0.5%");
});

it("formatContextPercent returns unknown for a non-positive window", () => {
  expect(formatContextPercent(1_000, 0)).toBe("unknown");
});

it("resolveContextUsage returns unknown when there are no activities", () => {
  expect(resolveContextUsage([])).toBe("unknown");
});

it("resolveContextUsage returns the percentage from the latest snapshot", () => {
  expect(resolveContextUsage([usage({ usedTokens: 40_000, maxTokens: 200_000 })])).toBe("20%");
});

it("resolveContextUsage uses the most recent context-window activity", () => {
  expect(
    resolveContextUsage([
      usage({ usedTokens: 40_000, maxTokens: 200_000 }),
      { kind: "message.appended", payload: {} },
      usage({ usedTokens: 100_000, maxTokens: 200_000 }),
    ]),
  ).toBe("50%");
});

it("resolveContextUsage returns unknown when the snapshot has no window size", () => {
  expect(resolveContextUsage([usage({ usedTokens: 1_000 })])).toBe("unknown");
});

it("resolveContextUsage ignores unrelated activity kinds", () => {
  expect(resolveContextUsage([{ kind: "message.appended", payload: {} }])).toBe("unknown");
});
