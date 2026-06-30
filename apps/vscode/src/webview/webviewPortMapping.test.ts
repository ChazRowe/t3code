import { describe, expect, it } from "vite-plus/test";

import {
  isLoopbackHttpUrl,
  resolveWebviewPortMappings,
  toWebviewLoopbackUrl,
} from "./webviewPortMapping.ts";

describe("webviewPortMapping", () => {
  it("detects loopback http urls", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:3773")).toBe(true);
    expect(isLoopbackHttpUrl("https://abc-3801.vscode-cdn.example/")).toBe(false);
  });

  it("maps loopback ports for webview localhost access", () => {
    expect(resolveWebviewPortMappings("http://127.0.0.1:3773")).toEqual([
      { webviewPort: 3773, extensionHostPort: 3773 },
    ]);
    expect(resolveWebviewPortMappings("https://abc-3801.vscode-cdn.example/")).toEqual([]);
  });

  it("rewrites 127.0.0.1 to localhost for webview fetches", () => {
    expect(toWebviewLoopbackUrl("http://127.0.0.1:3773/")).toBe("http://localhost:3773");
    expect(toWebviewLoopbackUrl("ws://127.0.0.1:3773")).toBe("ws://localhost:3773");
  });
});
