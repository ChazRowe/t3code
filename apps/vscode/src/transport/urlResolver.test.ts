import { describe, expect, it } from "vite-plus/test";

import { resolveExternalBaseUrls } from "./urlResolver.ts";

describe("resolveExternalBaseUrls", () => {
  it("returns the loopback URL unchanged locally and derives ws + readiness", async () => {
    const r = await resolveExternalBaseUrls({
      localHttpBaseUrl: "http://127.0.0.1:3801",
      asExternalUri: async (u) => u,
    });
    expect(r.httpBaseUrl).toBe("http://127.0.0.1:3801");
    expect(r.wsBaseUrl).toBe("ws://127.0.0.1:3801");
    expect(r.readinessUrl).toBe("http://127.0.0.1:3801/.well-known/t3/environment");
  });

  it("honours a forwarded https URL under Remote-SSH and yields wss", async () => {
    const r = await resolveExternalBaseUrls({
      localHttpBaseUrl: "http://127.0.0.1:3801",
      asExternalUri: async () => "https://abc-3801.vscode-cdn.example/",
    });
    expect(r.httpBaseUrl).toBe("https://abc-3801.vscode-cdn.example");
    expect(r.wsBaseUrl).toBe("wss://abc-3801.vscode-cdn.example");
    expect(r.readinessUrl).toBe("https://abc-3801.vscode-cdn.example/.well-known/t3/environment");
  });
});
