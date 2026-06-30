import { createContext, useContext } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** When `undefined`, the host is not the VSCode chat shell and route params should be used. */
export const VsCodeActiveThreadRefContext = createContext<ScopedThreadRef | null | undefined>(
  undefined,
);

export function useVsCodeActiveThreadRef(): ScopedThreadRef | null | undefined {
  return useContext(VsCodeActiveThreadRefContext);
}
