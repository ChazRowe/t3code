import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";

export interface VsCodeBridge {
  getLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null;
}

export const readVsCodeBridge = (): VsCodeBridge | null => {
  if (typeof window === "undefined") return null;
  return window.vscodeBridge ?? null;
};
