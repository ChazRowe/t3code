import type { OrchestrationSubagentRef } from "@t3tools/contracts";

export interface SubagentIterationGroup {
  readonly iteration: number;
  readonly refs: OrchestrationSubagentRef[];
}

export type SubagentForest =
  | { readonly kind: "ungrouped"; readonly refs: OrchestrationSubagentRef[] }
  | { readonly kind: "grouped"; readonly groups: SubagentIterationGroup[] };

/** Top-level refs are those with no parent (parentItemId === null). */
export function topLevelRefs(
  refs: ReadonlyArray<OrchestrationSubagentRef>,
): OrchestrationSubagentRef[] {
  return refs.filter((ref) => ref.parentItemId === null);
}

/** Direct children of a ref: refs whose parentItemId equals the given rootItemId. */
export function childRefsOf(
  refs: ReadonlyArray<OrchestrationSubagentRef>,
  rootItemId: string,
): OrchestrationSubagentRef[] {
  return refs.filter((ref) => ref.parentItemId === rootItemId);
}

export function buildSubagentForest(refs: ReadonlyArray<OrchestrationSubagentRef>): SubagentForest {
  const top = topLevelRefs(refs);
  const anyIteration = top.some((ref) => ref.iteration !== null);
  if (!anyIteration) {
    return { kind: "ungrouped", refs: top };
  }
  const byIteration = new Map<number, OrchestrationSubagentRef[]>();
  for (const ref of top) {
    const iteration = ref.iteration ?? 0;
    const bucket = byIteration.get(iteration);
    if (bucket) {
      bucket.push(ref);
    } else {
      byIteration.set(iteration, [ref]);
    }
  }
  const groups = [...byIteration.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([iteration, groupRefs]) => ({ iteration, refs: groupRefs }));
  return { kind: "grouped", groups };
}
