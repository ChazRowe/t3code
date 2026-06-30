import { describe, expect, it } from "vite-plus/test";
import * as net from "node:net";

import { findFreeLoopbackPort } from "./freePort.ts";

describe("findFreeLoopbackPort", () => {
  it("returns a port that is actually bindable on loopback", async () => {
    const port = await findFreeLoopbackPort({ startPort: 3773 });
    expect(port).toBeGreaterThanOrEqual(3773);
    // Prove it is usable: we can bind and release it.
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
  });

  it("skips a port that is already occupied", async () => {
    const occupied = await findFreeLoopbackPort({ startPort: 3900 });
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(occupied, "127.0.0.1", resolve));
    try {
      const next = await findFreeLoopbackPort({ startPort: occupied });
      expect(next).toBeGreaterThan(occupied);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
