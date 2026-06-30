import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { DesktopBackendBootstrap } from "@t3tools/contracts";

export const mintBootstrapToken = (randomBytes: (n: number) => Buffer = nodeRandomBytes): string =>
  randomBytes(24).toString("hex");

export interface BuildBootstrapInput {
  readonly port: number;
  readonly host: string;
  readonly t3Home: string;
  readonly token: string;
}

// Local-only embedded server: no browser, no tailscale, no relay. `mode: "desktop"`
// is the server's name for "embedded local server authenticated with a bootstrap
// token" — it is not Electron-specific.
export const buildBootstrap = (input: BuildBootstrapInput): DesktopBackendBootstrap => ({
  mode: "desktop",
  noBrowser: true,
  port: input.port,
  host: input.host,
  t3Home: input.t3Home,
  desktopBootstrapToken: input.token,
  tailscaleServeEnabled: false,
  // `tailscaleServePort: 1` is an unused placeholder — `tailscaleServeEnabled: false` disables
  // Tailscale, but the server's `PortSchema` requires 1–65535 so the field must still decode.
  // The value is ignored when serving is disabled.
  tailscaleServePort: 1,
});

export const serializeBootstrapLine = (bootstrap: DesktopBackendBootstrap): string =>
  `${JSON.stringify(bootstrap)}\n`;
