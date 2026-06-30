import { describe, expect, it } from "vite-plus/test";
import { ensureNodeTextContrast, stripLeakedControlTags } from "./mermaidRendering";

describe("ensureNodeTextContrast", () => {
  it("injects near-black text for an explicit light fill with no color", () => {
    const out = ensureNodeTextContrast("classDef floor fill:#eef6ff,stroke:#2471a3;");

    expect(out).toBe("classDef floor fill:#eef6ff,stroke:#2471a3,color:#1a1a1a;");
  });

  it("injects near-white text for an explicit dark fill", () => {
    const out = ensureNodeTextContrast("classDef deep fill:#1e3a5f,stroke:#000;");

    expect(out).toBe("classDef deep fill:#1e3a5f,stroke:#000,color:#f5f5f5;");
  });

  it("handles `style` statements and shorthand hex", () => {
    const out = ensureNodeTextContrast("  style N1 fill:#fff");

    expect(out).toBe("  style N1 fill:#fff,color:#1a1a1a");
  });

  it("handles named colors and rgb() fills", () => {
    expect(ensureNodeTextContrast("classDef a fill:lightblue")).toBe(
      "classDef a fill:lightblue,color:#1a1a1a",
    );
    expect(ensureNodeTextContrast("classDef b fill:rgb(20,20,20)")).toBe(
      "classDef b fill:rgb(20,20,20),color:#f5f5f5",
    );
  });

  it("respects an author-provided color and leaves it untouched", () => {
    const input = "classDef floor fill:#eef6ff,color:#333,stroke:#2471a3;";

    expect(ensureNodeTextContrast(input)).toBe(input);
  });

  it("leaves statements without a fill, or with an unmeasurable fill, alone", () => {
    expect(ensureNodeTextContrast("classDef edgey stroke:#2471a3;")).toBe(
      "classDef edgey stroke:#2471a3;",
    );
    expect(ensureNodeTextContrast("classDef ghost fill:none;")).toBe("classDef ghost fill:none;");
    expect(ensureNodeTextContrast("classDef v fill:var(--x);")).toBe("classDef v fill:var(--x);");
  });

  it("only rewrites classDef/style lines, not the rest of the diagram", () => {
    const diagram = [
      "flowchart TD",
      "  A[start] --> B[end]",
      "  classDef hot fill:#fdedec;",
      "  class A,B hot",
    ].join("\n");

    expect(ensureNodeTextContrast(diagram)).toBe(
      [
        "flowchart TD",
        "  A[start] --> B[end]",
        "  classDef hot fill:#fdedec,color:#1a1a1a;",
        "  class A,B hot",
      ].join("\n"),
    );
  });

  it("composes with leaked-tag stripping without disturbing classDefs", () => {
    const input = "classDef floor fill:#eef6ff;\n</parameter>";

    expect(ensureNodeTextContrast(stripLeakedControlTags(input))).toBe(
      "classDef floor fill:#eef6ff,color:#1a1a1a;\n",
    );
  });
});
