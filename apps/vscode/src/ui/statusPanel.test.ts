import { describe, expect, it } from "vite-plus/test";

import { renderStatusHtml, shouldContinueStatusPolling } from "./statusPanel.ts";

describe("renderStatusHtml", () => {
  it("renders the resolved URLs and descriptor when ready", () => {
    const html = renderStatusHtml({
      ready: true,
      httpBaseUrl: "http://127.0.0.1:3801",
      wsBaseUrl: "ws://127.0.0.1:3801",
      descriptorJson: '{"environmentId":"env_1"}',
      error: null,
    });
    expect(html).toContain("http://127.0.0.1:3801");
    expect(html).toContain("ws://127.0.0.1:3801");
    expect(html).toContain("env_1");
    expect(html.toLowerCase()).toContain("ready");
  });

  it("renders a pending startup state without empty URL fields", () => {
    const html = renderStatusHtml({
      ready: false,
      httpBaseUrl: "",
      wsBaseUrl: "",
      descriptorJson: null,
      error: null,
    });
    expect(html.toLowerCase()).toContain("starting");
    expect(html).toContain("Embedded server is starting.");
    expect(html).not.toContain("<dt>HTTP</dt>");
  });

  it("continues polling while startup is pending and stops on ready or error", () => {
    expect(
      shouldContinueStatusPolling({
        ready: false,
        httpBaseUrl: "",
        wsBaseUrl: "",
        descriptorJson: null,
        error: null,
      }),
    ).toBe(true);
    expect(
      shouldContinueStatusPolling({
        ready: true,
        httpBaseUrl: "http://127.0.0.1:3801",
        wsBaseUrl: "ws://127.0.0.1:3801",
        descriptorJson: "{}",
        error: null,
      }),
    ).toBe(false);
    expect(
      shouldContinueStatusPolling({
        ready: false,
        httpBaseUrl: "",
        wsBaseUrl: "",
        descriptorJson: null,
        error: "Server exited during startup (code=1)",
      }),
    ).toBe(false);
  });

  it("escapes HTML in the error to avoid injection", () => {
    const html = renderStatusHtml({
      ready: false,
      httpBaseUrl: "",
      wsBaseUrl: "",
      descriptorJson: null,
      error: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
