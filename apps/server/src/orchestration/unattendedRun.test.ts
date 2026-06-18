import { describe, expect, it } from "vite-plus/test";

import {
  buildUnattendedPreamble,
  CONTINUE_MESSAGE,
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

  it("has a non-empty continue message", () => {
    expect(CONTINUE_MESSAGE.length).toBeGreaterThan(0);
  });
});
