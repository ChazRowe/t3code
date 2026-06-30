import * as net from "node:net";

const canBind = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (cause: NodeJS.ErrnoException) => {
      // EADDRNOTAVAIL: host (e.g. IPv6 ::1) absent — treat as "not occupied".
      resolve(cause.code === "EADDRNOTAVAIL");
    });
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ host, port });
  });

export interface FindFreePortOptions {
  readonly startPort?: number;
  readonly maxPort?: number;
}

export const findFreeLoopbackPort = async (options: FindFreePortOptions = {}): Promise<number> => {
  const startPort = options.startPort ?? 3773;
  const maxPort = options.maxPort ?? 65535;
  for (let port = startPort; port <= maxPort; port += 1) {
    const v4 = await canBind(port, "127.0.0.1");
    if (!v4) continue;
    const v6 = await canBind(port, "::1");
    if (v6) return port;
  }
  throw new Error(`No free loopback port found between ${startPort} and ${maxPort}.`);
};
