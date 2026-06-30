import { describe, expect, it } from "vite-plus/test";

import { buildBootstrap, mintBootstrapToken, serializeBootstrapLine } from "./bootstrap.ts";

describe("bootstrap", () => {
  it("mints a 48-char hex token from 24 random bytes", () => {
    const token = mintBootstrapToken((n) => Buffer.alloc(n, 0xab));
    expect(token).toBe("ab".repeat(24));
    expect(token).toHaveLength(48);
  });

  it("builds the local-only desktop bootstrap envelope", () => {
    const bootstrap = buildBootstrap({
      port: 3773,
      host: "127.0.0.1",
      t3Home: "/home/u/.t3",
      token: "tok",
    });
    expect(bootstrap).toMatchObject({
      mode: "desktop",
      noBrowser: true,
      port: 3773,
      host: "127.0.0.1",
      t3Home: "/home/u/.t3",
      desktopBootstrapToken: "tok",
      tailscaleServeEnabled: false,
    });
    expect(typeof bootstrap.tailscaleServePort).toBe("number");
  });

  it("serializes a single newline-terminated JSON line", () => {
    const line = serializeBootstrapLine(
      buildBootstrap({ port: 3773, host: "127.0.0.1", t3Home: "/x", token: "tok" }),
    );
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1); // exactly one newline, at the end
    expect(JSON.parse(line) as { port: number }).toMatchObject({ port: 3773, mode: "desktop" });
  });
});
