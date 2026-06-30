import { describe, expect, it } from "vite-plus/test";

import { buildConnectSrcOrigins, renderWebviewHtml } from "./webviewHtml.ts";

describe("renderWebviewHtml", () => {
  it("injects vscodeBridge bootstrap and CSP connect-src for ws/http", () => {
    const html = renderWebviewHtml({
      nonce: "abc123",
      bootstrap: {
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3801",
        wsBaseUrl: "ws://127.0.0.1:3801",
        bootstrapToken: "tok",
      },
      scriptUri: "https://file+.vscode-resource.vscode-cdn.net/dist/webview/chat/assets/index.js",
      styleUris: [],
      connectSrcOrigins: buildConnectSrcOrigins("http://127.0.0.1:3801", "ws://127.0.0.1:3801"),
    });
    expect(html).toContain("vscodeBridge");
    expect(html).toContain("acquireVsCodeApi");
    expect(html).toContain("t3code.http.fetch");
    expect(html).toContain("t3code.ws.connect");
    expect(html).toContain("LoopbackWebSocket");
    expect(html).toContain("tok");
    expect(html).toContain("connect-src");
    expect(html).toContain("ws://127.0.0.1:3801");
    expect(html).toContain("nonce-abc123");
    expect(html).toContain("script-src 'nonce-abc123' 'self' https://*.vscode-cdn.net");
    // Blob workers (the webview-safe diffs/shiki worker) require worker-src blob:.
    expect(html).toContain("worker-src 'self' https://*.vscode-cdn.net blob:");
    expect(html).not.toContain("<script>alert");
  });

  it("serializes Uint8Array POST bodies for the HTTP proxy bridge", () => {
    const html = renderWebviewHtml({
      nonce: "n",
      bootstrap: {
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:1",
        wsBaseUrl: "ws://127.0.0.1:1",
        bootstrapToken: "tok",
      },
      scriptUri: "https://example/vscode-resource/index.js",
      styleUris: [],
      connectSrcOrigins: ["http://127.0.0.1:1", "ws://127.0.0.1:1"],
    });
    expect(html).toContain("instanceof Uint8Array");
    expect(html).toContain("TextDecoder");
  });

  it("escapes bootstrap json for inline injection", () => {
    const html = renderWebviewHtml({
      nonce: "n",
      bootstrap: {
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:1",
        wsBaseUrl: "ws://127.0.0.1:1",
        bootstrapToken: "</script>",
      },
      scriptUri: "https://example/vscode-resource/index.js",
      styleUris: [],
      connectSrcOrigins: ["http://127.0.0.1:1", "ws://127.0.0.1:1"],
    });
    expect(html).not.toContain("</script><script");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});

describe("buildConnectSrcOrigins", () => {
  it("deduplicates http and ws origins", () => {
    expect(buildConnectSrcOrigins("http://127.0.0.1:3801", "ws://127.0.0.1:3801")).toEqual([
      "http://127.0.0.1:3801",
      "ws://127.0.0.1:3801",
    ]);
  });
});
