import { describe, expect, it } from "vite-plus/test";

import { resolveEmbeddedServerSpawnArgs } from "./embeddedServerArgs.ts";

describe("resolveEmbeddedServerSpawnArgs", () => {
  it("passes workspace bootstrap flags when a folder workspace is open", () => {
    expect(
      resolveEmbeddedServerSpawnArgs({
        entryPath: "/bin/server.mjs",
        workspaceCwd: "/home/user/project",
      }),
    ).toEqual([
      "/bin/server.mjs",
      "--bootstrap-fd",
      "3",
      "--auto-bootstrap-project-from-cwd",
      "--auto-bootstrap-create-new-thread",
      "/home/user/project",
    ]);
  });

  it("omits bootstrap flags when no workspace folder is available", () => {
    expect(
      resolveEmbeddedServerSpawnArgs({
        entryPath: "/bin/server.mjs",
        workspaceCwd: undefined,
      }),
    ).toEqual(["/bin/server.mjs", "--bootstrap-fd", "3"]);
  });
});
