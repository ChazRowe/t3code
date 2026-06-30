// @effect-diagnostics nodeBuiltinImport:off - Extension host runs as plain Node outside any Effect runtime; node:path is intentional.
import * as path from "node:path";

export interface ResolveServerEntryInput {
  readonly extensionPath: string;
  readonly execPath: string;
  readonly fileExists: (filePath: string) => boolean;
}

export interface ResolvedServerEntry {
  readonly command: string;
  readonly entryPath: string;
  readonly spawnEnv: Record<string, string>;
}

export const resolveServerEntry = (input: ResolveServerEntryInput): ResolvedServerEntry => {
  const packaged = path.join(input.extensionPath, "server", "dist", "bin.mjs");
  const dev = path.resolve(input.extensionPath, "..", "..", "apps", "server", "dist", "bin.mjs");
  const entryPath = input.fileExists(packaged) ? packaged : input.fileExists(dev) ? dev : null;
  if (entryPath === null) {
    throw new Error(
      `Server bin not found. Looked in:\n  ${packaged}\n  ${dev}\nRun \`pnpm build:server\`.`,
    );
  }
  return {
    command: input.execPath,
    entryPath,
    // Run the host's Electron/Node binary as plain Node so the child is not a GUI instance.
    spawnEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
};
