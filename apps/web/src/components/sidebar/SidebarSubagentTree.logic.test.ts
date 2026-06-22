import { describe, expect, it } from "vite-plus/test";
import { RuntimeItemId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationSubagentRef } from "@t3tools/contracts";

import { buildSubagentForest, childRefsOf } from "./SidebarSubagentTree.logic";

function makeRef(overrides: Partial<OrchestrationSubagentRef>): OrchestrationSubagentRef {
  return {
    threadId: ThreadId.make("thread-1"),
    rootItemId: RuntimeItemId.make("root"),
    parentItemId: null,
    label: "x: y",
    subagentType: "x",
    description: "y",
    status: "inProgress",
    iteration: null,
    turnId: null,
    depth: 0,
    childSubagentCount: 0,
    prompt: null,
    resultText: null,
    childThreadId: null,
    providerInstanceId: null,
    provider: null,
    model: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSubagentForest", () => {
  it("returns ungrouped top-level refs when iteration is null", () => {
    const a = makeRef({ rootItemId: RuntimeItemId.make("a") });
    const b = makeRef({ rootItemId: RuntimeItemId.make("b") });
    const forest = buildSubagentForest([a, b]);
    expect(forest.kind).toBe("ungrouped");
    if (forest.kind === "ungrouped") {
      expect(forest.refs.map((r) => r.rootItemId)).toEqual(["a", "b"]);
    }
  });

  it("groups top-level refs by iteration ascending when iteration is set", () => {
    const a = makeRef({ rootItemId: RuntimeItemId.make("a"), iteration: 2 });
    const b = makeRef({ rootItemId: RuntimeItemId.make("b"), iteration: 1 });
    const forest = buildSubagentForest([a, b]);
    expect(forest.kind).toBe("grouped");
    if (forest.kind === "grouped") {
      expect(forest.groups.map((g) => g.iteration)).toEqual([1, 2]);
      expect(forest.groups[0]?.refs.map((r) => r.rootItemId)).toEqual(["b"]);
    }
  });

  it("places null-iteration refs into group 0 when mixed with numbered iterations", () => {
    const nullIter = makeRef({ rootItemId: RuntimeItemId.make("null-iter"), iteration: null });
    const oneIter = makeRef({ rootItemId: RuntimeItemId.make("one-iter"), iteration: 1 });
    const forest = buildSubagentForest([nullIter, oneIter]);
    expect(forest.kind).toBe("grouped");
    if (forest.kind === "grouped") {
      expect(forest.groups.map((g) => g.iteration)).toEqual([0, 1]);
      expect(forest.groups[0]?.refs.map((r) => r.rootItemId)).toEqual(["null-iter"]);
    }
  });
});

describe("childRefsOf", () => {
  it("returns refs whose parentItemId matches", () => {
    const parent = makeRef({ rootItemId: RuntimeItemId.make("p") });
    const child = makeRef({
      rootItemId: RuntimeItemId.make("c"),
      parentItemId: RuntimeItemId.make("p"),
      depth: 1,
    });
    const other = makeRef({ rootItemId: RuntimeItemId.make("o") });
    expect(
      childRefsOf([parent, child, other], RuntimeItemId.make("p")).map((r) => r.rootItemId),
    ).toEqual(["c"]);
  });
});
