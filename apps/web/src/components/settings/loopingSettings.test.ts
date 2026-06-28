import { describe, expect, it } from "vite-plus/test";

import { preambleMissingEffectiveSentinel } from "./loopingSettings.ts";

describe("preambleMissingEffectiveSentinel", () => {
  it("is false for an empty preamble (the built-in default is used)", () => {
    expect(preambleMissingEffectiveSentinel("", "<<WRAP_COMPLETE>>")).toBe(false);
    expect(preambleMissingEffectiveSentinel("   ", "<<WRAP_COMPLETE>>")).toBe(false);
  });

  it("is false when a custom preamble contains the effective sentinel", () => {
    expect(
      preambleMissingEffectiveSentinel("emit <<WRAP_COMPLETE>> to advance", "<<WRAP_COMPLETE>>"),
    ).toBe(false);
  });

  it("is true when a custom preamble omits the effective sentinel", () => {
    expect(preambleMissingEffectiveSentinel("just do the work", "<<WRAP_COMPLETE>>")).toBe(true);
  });

  it("respects a custom effective sentinel", () => {
    expect(preambleMissingEffectiveSentinel("emit <<DONE>>", "<<DONE>>")).toBe(false);
    expect(preambleMissingEffectiveSentinel("emit <<WRAP_COMPLETE>>", "<<DONE>>")).toBe(true);
  });
});
