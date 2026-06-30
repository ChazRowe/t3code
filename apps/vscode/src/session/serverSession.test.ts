import { describe, expect, it } from "vite-plus/test";

import { resolveServerSession } from "./serverSession.ts";

describe("resolveServerSession", () => {
  it("returns loopback urls unchanged locally", async () => {
    const session = await resolveServerSession({
      localHttpBaseUrl: "http://127.0.0.1:3801",
      bootstrapToken: "tok",
      asExternalUri: async (url) => url,
    });
    expect(session).toEqual({
      httpBaseUrl: "http://127.0.0.1:3801",
      wsBaseUrl: "ws://127.0.0.1:3801",
      localHttpBaseUrl: "http://127.0.0.1:3801",
      bootstrapToken: "tok",
      label: "Local environment",
    });
  });

  it("honours forwarded https/wss urls under Remote-SSH", async () => {
    const session = await resolveServerSession({
      localHttpBaseUrl: "http://127.0.0.1:3801",
      bootstrapToken: "tok",
      label: "Remote",
      asExternalUri: async () => "https://abc-3801.vscode-cdn.example/",
    });
    expect(session.httpBaseUrl).toBe("https://abc-3801.vscode-cdn.example");
    expect(session.wsBaseUrl).toBe("wss://abc-3801.vscode-cdn.example");
    expect(session.localHttpBaseUrl).toBe("http://127.0.0.1:3801");
    expect(session.label).toBe("Remote");
  });
});
