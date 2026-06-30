// @effect-diagnostics nodeBuiltinImport:off - Extension host runs as plain Node outside any Effect runtime; node:path is intentional.
import { describe, expect, it } from "vite-plus/test";
import * as path from "node:path";

import { resolveServerEntry } from "./serverEntry.ts";

const ext = "/opt/ext/t3code";
const packaged = path.join(ext, "server", "dist", "bin.mjs");
const dev = path.resolve(ext, "..", "..", "apps", "server", "dist", "bin.mjs");

describe("resolveServerEntry", () => {
  it("prefers the packaged server bin when present", () => {
    const r = resolveServerEntry({
      extensionPath: ext,
      execPath: "/usr/bin/node",
      fileExists: (p) => p === packaged,
    });
    expect(r.entryPath).toBe(packaged);
    expect(r.command).toBe("/usr/bin/node");
    expect(r.spawnEnv.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("falls back to the monorepo dev path", () => {
    const r = resolveServerEntry({
      extensionPath: ext,
      execPath: "/usr/bin/node",
      fileExists: (p) => p === dev,
    });
    expect(r.entryPath).toBe(dev);
  });

  it("throws when no server bin exists", () => {
    expect(() =>
      resolveServerEntry({
        extensionPath: ext,
        execPath: "/usr/bin/node",
        fileExists: () => false,
      }),
    ).toThrow(/server bin not found/i);
  });
});
