// @effect-diagnostics nodeBuiltinImport:off - VSIX staging copies server dist with Node fs/path.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const vscodeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDist = join(vscodeRoot, "..", "server", "dist");
const target = join(vscodeRoot, "server", "dist");
const serverBin = join(serverDist, "bin.mjs");

if (!existsSync(serverBin)) {
  throw new Error(
    `Server dist missing at ${serverBin}. Run \`pnpm build:server\` from the repo root first.`,
  );
}

rmSync(target, { recursive: true, force: true });
cpSync(serverDist, target, { recursive: true });
