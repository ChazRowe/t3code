import { describe, expect, it, vi, afterEach } from "vite-plus/test";

import { readPrimaryEnvironmentTarget } from "./target.ts";

describe("readPrimaryEnvironmentTarget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses vscodeBridge bootstrap urls when present", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://file+.vscode-resource.vscode-cdn.net/" },
      desktopBridge: undefined,
      vscodeBridge: {
        getLocalEnvironmentBootstrap: () => ({
          label: "Local environment",
          httpBaseUrl: "https://abc-3801.vscode-cdn.example/",
          wsBaseUrl: "wss://abc-3801.vscode-cdn.example/",
          bootstrapToken: "vscode-bootstrap-token",
        }),
      },
    });

    expect(readPrimaryEnvironmentTarget()).toEqual({
      source: "vscode-managed",
      target: {
        httpBaseUrl: "https://abc-3801.vscode-cdn.example/",
        wsBaseUrl: "wss://abc-3801.vscode-cdn.example/",
      },
    });
  });
});
