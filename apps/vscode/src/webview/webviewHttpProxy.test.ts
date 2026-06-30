import { describe, expect, it, vi } from "vite-plus/test";

import {
  isWebviewHttpFetchMessage,
  proxyWebviewHttpFetch,
  rewriteLoopbackFetchUrl,
} from "./webviewHttpProxy.ts";

describe("rewriteLoopbackFetchUrl", () => {
  it("rewrites localhost requests to the local server bind address", () => {
    expect(
      rewriteLoopbackFetchUrl(
        "http://localhost:3774/.well-known/t3/environment",
        "http://127.0.0.1:3774",
      ),
    ).toBe("http://127.0.0.1:3774/.well-known/t3/environment");
  });

  it("leaves non-loopback urls unchanged", () => {
    expect(
      rewriteLoopbackFetchUrl(
        "https://abc-3774.vscode-cdn.example/.well-known/t3/environment",
        "http://127.0.0.1:3774",
      ),
    ).toBe("https://abc-3774.vscode-cdn.example/.well-known/t3/environment");
  });
});

describe("isWebviewHttpFetchMessage", () => {
  it("accepts fetch messages", () => {
    expect(
      isWebviewHttpFetchMessage({
        type: "t3code.http.fetch",
        id: "1",
        url: "http://localhost:3774/.well-known/t3/environment",
      }),
    ).toBe(true);
  });

  it("rejects unrelated messages", () => {
    expect(isWebviewHttpFetchMessage({ type: "other" })).toBe(false);
  });
});

describe("proxyWebviewHttpFetch", () => {
  it("returns proxied responses", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true }, { status: 200, statusText: "OK" }),
    );
    const result = await proxyWebviewHttpFetch(
      {
        type: "t3code.http.fetch",
        id: "req-1",
        url: "http://localhost:3774/.well-known/t3/environment",
        method: "GET",
      },
      "http://127.0.0.1:3774",
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3774/.well-known/t3/environment", {
      method: "GET",
      headers: undefined,
    });
    expect(result).toMatchObject({
      type: "t3code.http.result",
      id: "req-1",
      status: 200,
      statusText: "OK",
      body: '{"ok":true}',
    });
  });

  it("maps transport failures to network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const result = await proxyWebviewHttpFetch(
      {
        type: "t3code.http.fetch",
        id: "req-2",
        url: "http://localhost:3774/.well-known/t3/environment",
      },
      "http://127.0.0.1:3774",
      fetchImpl,
    );
    expect(result.networkError).toBe(true);
    expect(result.body).toContain("connection refused");
  });
});
