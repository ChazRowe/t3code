import { describe, expect, it } from "vite-plus/test";

import {
  buildContextClearedSummary,
  buildContextFreshSummary,
  buildUnattendedPreamble,
  CONTINUE_MESSAGE,
  CONTEXT_CLEARED_ACTIVITY_KIND,
  CONTEXT_FRESH_ACTIVITY_KIND,
  isOneMillionContextModel,
  messageHasWrapSentinel,
  resolveAppendedLastMessage,
  resolveUnattendedWrapCeilingPercent,
  stripSentinelLine,
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

  it("preamble states a ~35% wrap-budget ceiling for standard models", () => {
    const preamble = buildUnattendedPreamble(5, "gpt-5-codex");
    expect(preamble).toContain("35%");
    expect(preamble.toLowerCase()).toContain("ceiling");
    expect(preamble).toContain("context_usage");
    expect(preamble).toContain("MCP context server");
  });

  it("preamble states a ~15% wrap-budget ceiling for 1M-context models", () => {
    const preamble = buildUnattendedPreamble(5, "claude-opus-4-8[1m]");
    expect(preamble).toContain("15%");
    expect(preamble).not.toContain("35%");
    // The ceiling is anchored to the authoritative tool, not the agent's own
    // (unreliable) sense of the window size.
    expect(preamble).toContain("context_usage");
    expect(preamble.toLowerCase()).toContain("do not");
  });

  it("detects explicit 1M context model identifiers", () => {
    expect(isOneMillionContextModel("claude-opus-4-8[1m]")).toBe(true);
    expect(isOneMillionContextModel("gpt-5.4-medium-fast[reasoning=medium,context=1m]")).toBe(true);
    expect(isOneMillionContextModel("gpt-5-codex")).toBe(false);
    expect(resolveUnattendedWrapCeilingPercent("claude-opus-4-8[1m]")).toBe(15);
    expect(resolveUnattendedWrapCeilingPercent("gpt-5-codex")).toBe(35);
  });

  it("has a non-empty continue message", () => {
    expect(CONTINUE_MESSAGE.length).toBeGreaterThan(0);
  });

  it("preamble tells the agent that ending a turn without the sentinel never pauses", () => {
    const preamble = buildUnattendedPreamble(3).toLowerCase();
    expect(preamble).toContain("never pauses");
    // The agent may end its turn to let background work (e.g. a subagent) finish.
    expect(preamble).toContain("subagent");
    // Only the user controls pause/stop.
    expect(preamble).toContain("only i pause or stop");
  });

  it("embeds a custom sentinel in the preamble when one is passed", () => {
    const preamble = buildUnattendedPreamble(5, "gpt-5-codex", "<<DONE>>");
    expect(preamble).toContain("<<DONE>>");
    expect(preamble).not.toContain(WRAP_SENTINEL);
  });

  it("defaults the preamble sentinel to WRAP_SENTINEL when none is passed", () => {
    expect(buildUnattendedPreamble(5)).toContain(WRAP_SENTINEL);
  });

  it("detects a custom sentinel and ignores the default when a custom one is set", () => {
    expect(messageHasWrapSentinel("all done\n<<DONE>>", "<<DONE>>")).toBe(true);
    expect(messageHasWrapSentinel(`all done\n${WRAP_SENTINEL}`, "<<DONE>>")).toBe(false);
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

describe("stripSentinelLine", () => {
  it("removes a standalone sentinel line and trims the result", () => {
    expect(stripSentinelLine("did the work\n<<WRAP_COMPLETE>>", "<<WRAP_COMPLETE>>")).toBe(
      "did the work",
    );
  });

  it("removes a sentinel line surrounded by whitespace", () => {
    expect(stripSentinelLine("  <<WRAP_COMPLETE>>  ", "<<WRAP_COMPLETE>>")).toBe("");
  });

  it("preserves text on either side of the sentinel line", () => {
    expect(stripSentinelLine("line a\n<<WRAP_COMPLETE>>\nline b", "<<WRAP_COMPLETE>>")).toBe(
      "line a\nline b",
    );
  });

  it("leaves text without the sentinel unchanged", () => {
    expect(stripSentinelLine("nothing to strip", "<<WRAP_COMPLETE>>")).toBe("nothing to strip");
  });
});

describe("resolveAppendedLastMessage", () => {
  it("returns the latest message with its sentinel line stripped", () => {
    expect(
      resolveAppendedLastMessage(
        ["older", "final summary\n<<WRAP_COMPLETE>>"],
        "<<WRAP_COMPLETE>>",
      ),
    ).toBe("final summary");
  });

  it("falls back to the previous message when the latest is a standalone sentinel", () => {
    expect(
      resolveAppendedLastMessage(["substantive work", "<<WRAP_COMPLETE>>"], "<<WRAP_COMPLETE>>"),
    ).toBe("substantive work");
  });

  it("returns null when nothing substantive remains", () => {
    expect(
      resolveAppendedLastMessage(["<<WRAP_COMPLETE>>", "   "], "<<WRAP_COMPLETE>>"),
    ).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(resolveAppendedLastMessage([], "<<WRAP_COMPLETE>>")).toBeNull();
  });

  it("picks the latest qualifying message from a longer list", () => {
    expect(
      resolveAppendedLastMessage(["a", "b", "c\n<<WRAP_COMPLETE>>"], "<<WRAP_COMPLETE>>"),
    ).toBe("c");
  });
});
