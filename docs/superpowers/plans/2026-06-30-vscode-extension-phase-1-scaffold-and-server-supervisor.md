# VSCode Extension — Phase 1: Package Scaffold + Server Supervisor — Implementation Plan

> **Status:** COMPLETE (2026-06-30). Operator-verified Status webview + VSIX packaging; restart/orphan acceptance covered by `pnpm --filter t3-code smoke-test` (`apps/vscode/scripts/smokeSupervisor.ts`). Remote-SSH manual smoke (Step 7.8) not run.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Stand up the new `apps/vscode` (`@t3tools/vscode-extension`) workspace package so that, when run in the VSCode Extension Development Host, it spawns and supervises the `@t3tools/server` child on a loopback port (free-port scan → `--bootstrap-fd 3` newline-JSON handshake → readiness poll → exponential-backoff auto-restart → graceful SIGTERM stop), resolves the server's externally-reachable base URL via `vscode.env.asExternalUri`, and proves end-to-end connectivity (local **and** Remote-SSH) through a minimal "T3 Code: Status" webview that fetches and displays `/.well-known/t3/environment`.

**Architecture:** This is the third shell over the existing backend, after `apps/web` and `apps/desktop`. It follows the desktop app's proven embedding model but **does not depend on `@t3tools/desktop`** (per the design spec). Instead it **ports the supervisor algorithm** into a small, dependency-light, plain-Node extension host — reusing only the shared **contract** (`DesktopBackendBootstrap` type from `@t3tools/contracts`) and the **wire protocol** (`--bootstrap-fd 3` + newline JSON + readiness path), not the Effect/Electron implementation. The Effect runtime is **not** used in the extension host; the supervisor, free-port scan, bootstrap builder, and URL resolver are pure, dependency-injected modules (no `vscode` import) so they are unit-testable, and `src/extension.ts` is the only file that touches the `vscode` namespace. No web-app UI, no transport client, no native bridge yet — those are Phases 2–4 (see roadmap at the end).

**Tech Stack:** TypeScript (NodeNext, strict), VSCode Extension API (`engines.vscode`), `vite-plus` `pack` (tsdown) for the CJS extension-host bundle, Vitest via `vite-plus/test` (test files import from `"vite-plus/test"`). Node `child_process` / `net` / `crypto` for the supervisor. `@t3tools/contracts` (type-only) for the bootstrap shape.

## Global Constraints

These apply to **every task** in this plan. Values copied verbatim from the spec / repo config.

- **Package name:** `@t3tools/vscode-extension`, `"private": true`, `"type": "module"`. Picked up automatically by the `apps/*` glob already in `pnpm-workspace.yaml` (no workspace edit needed).
- **`extensionKind`:** `["workspace"]` — under Remote Development the extension host and the spawned server both run on the **remote host**.
- **No dependency on `@t3tools/desktop`.** Reuse is limited to: the `DesktopBackendBootstrap` **type** from `@t3tools/contracts` (type-only import, erased at build), and the documented wire protocol. Do **not** import `DesktopBackendManager`, `NetService`, or any `apps/desktop/**` module.
- **Local-only auth.** Reuse the desktop local bootstrap-token path: a random hex token minted per activation, passed to the server in the fd-3 bootstrap as `desktopBootstrapToken`. No Clerk, no Tailscale, no relay. The bootstrap `mode` is the literal `"desktop"` (the server's name for "embedded local server with a bootstrap token" — it is not Electron-specific).
- **TS config (inherited from `tsconfig.base.json`):** `module`/`moduleResolution` = `NodeNext`; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; `verbatimModuleSyntax` (use `import type` for type-only imports); `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (relative imports **must** carry the `.ts` extension, e.g. `import { x } from "./bootstrap.ts"`); `erasableSyntaxOnly` (**no `enum`, no `namespace`, no parameter properties** — use `const` objects with `as const`).
- **Repo lint conventions:** no `console.*` in committed code — log through a `vscode.OutputChannel` wrapped behind an injected `Logger` interface (the pure modules receive a `Logger`, never call `console`). Do not use `crypto.randomUUID()`; mint the token with `crypto.randomBytes(...)` + hex (matches the desktop pattern).
- **Workspace deps are source-only** (no build step): `@t3tools/contracts` exposes `./src/index.ts` via its `exports` map; importing its types needs no prior build.
- **Server child entry:** the built `@t3tools/server` bin at `apps/server/dist/bin.mjs` (package name `t3`). It must be built (`pnpm build:server`) before the extension can spawn it; the extension's `build` task declares `dependsOn: ["t3#build"]`, mirroring `apps/desktop`.
- **Test runner:** `vp` (vite-plus). Test files import from `"vite-plus/test"`, **not** `"vitest"`. Run a package's tests with `pnpm --filter @t3tools/vscode-extension test` (or `cd apps/vscode && pnpm test`). Typecheck: `cd apps/vscode && pnpm typecheck` (`tsgo --noEmit`). Lint: `pnpm lint` from repo root.

---

## File Structure (created by this phase)

```
apps/vscode/
  package.json              # VSCode manifest + workspace deps + scripts
  tsconfig.json             # extends ../../tsconfig.base.json; types: node, vscode
  vite.config.ts            # pack (tsdown) → dist/extension.cjs (CJS, `vscode` external)
  .vscodeignore             # exclude src/tests from the packaged extension
  README.md                 # one-paragraph dev/run instructions
  src/
    extension.ts            # THE ONLY file importing `vscode`: activate()/deactivate(), wires the pure modules to real VSCode APIs + the status webview
    logger.ts               # Logger interface + OutputChannel-backed impl
    server/
      freePort.ts           # pure: scan for a free loopback port (node:net)
      freePort.test.ts
      bootstrap.ts          # pure: mint token + build DesktopBackendBootstrap object + serialize the fd-3 line
      bootstrap.test.ts
      serverEntry.ts        # pure: resolve node exec path + server bin path (dev vs packaged)
      serverEntry.test.ts
      serverSupervisor.ts   # pure (DI): spawn + fd-3 write + readiness poll + backoff restart + stop
      serverSupervisor.test.ts
    transport/
      urlResolver.ts        # pure (DI): wrap asExternalUri; derive ws base + readiness URL
      urlResolver.test.ts
    ui/
      statusPanel.ts        # builds the minimal status webview HTML (pure string builder, testable)
      statusPanel.test.ts
```

Responsibilities:
- **`server/freePort.ts`** — find an available loopback TCP port starting at 3773, probing `127.0.0.1` and `::1` (mirrors the desktop scan's intent without importing it).
- **`server/bootstrap.ts`** — mint the random bootstrap token and produce both the typed `DesktopBackendBootstrap` object and the exact `string` line written to fd 3.
- **`server/serverEntry.ts`** — decide which Node binary to spawn (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`) and locate `apps/server/dist/bin.mjs` (packaged copy first, monorepo dev path fallback).
- **`server/serverSupervisor.ts`** — the core lifecycle state machine; every external effect (spawn, http probe, timer, logger) is injected so it runs headless in tests.
- **`transport/urlResolver.ts`** — turn the loopback `http://127.0.0.1:<port>` into the externally-reachable base URL (identity locally, forwarded under Remote-SSH) and derive the `ws*` base + readiness URL.
- **`ui/statusPanel.ts`** — pure HTML builder for the verification webview (no `vscode` import; takes plain data).
- **`extension.ts`** — glue: activation, OutputChannel logger, command registration, supervisor start/stop tied to the extension lifecycle, and the status webview that calls the resolver + fetches the descriptor.

---

## Task 1: Scaffold the `apps/vscode` package (manifest, tsconfig, build, activation stub)

**Files:**
- Create: `apps/vscode/package.json`
- Create: `apps/vscode/tsconfig.json`
- Create: `apps/vscode/vite.config.ts`
- Create: `apps/vscode/.vscodeignore`
- Create: `apps/vscode/README.md`
- Create: `apps/vscode/src/extension.ts` (activation stub for this task; expanded in Task 7)
- Create: `apps/vscode/src/logger.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the buildable package; `Logger` interface (`{ info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void }`) and `createOutputChannelLogger(channel: { appendLine(line: string): void }): Logger` from `src/logger.ts`, reused by every later task.

- [x] **Step 1: Write `apps/vscode/package.json`**

```jsonc
{
  "name": "@t3tools/vscode-extension",
  "displayName": "T3 Code",
  "description": "T3 Code session experience inside VSCode.",
  "version": "0.0.27",
  "private": true,
  "type": "module",
  "publisher": "t3tools",
  "engines": {
    "vscode": "^1.90.0",
    "node": "^24.13.1"
  },
  "main": "./dist/extension.cjs",
  "extensionKind": ["workspace"],
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "commands": [
      {
        "command": "t3code.showStatus",
        "title": "T3 Code: Status",
        "category": "T3 Code"
      }
    ]
  },
  "scripts": {
    "build": "vp pack",
    "dev": "vp pack --watch",
    "typecheck": "tsgo --noEmit",
    "test": "vp test run"
  },
  "dependencies": {
    "@t3tools/contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "@types/vscode": "^1.90.0",
    "vite-plus": "catalog:"
  }
}
```

Note: `@types/vscode` pins the same floor as `engines.vscode`. The `build` script does **not** yet declare `dependsOn: ["t3#build"]` here — that is added in `vite.config.ts`'s `run.tasks` (Step 3), matching how `apps/desktop` does it.

- [x] **Step 2: Write `apps/vscode/tsconfig.json`** (mirrors `apps/desktop/tsconfig.json`, swapping `electron` types for `vscode`)

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "types": ["node", "vscode"],
    "lib": ["ESNext", "DOM", "esnext.disposable"]
  },
  "include": ["src", "vite.config.ts"]
}
```

(`DOM` lib is included because `ui/statusPanel.ts` builds HTML strings and the webview-message types reference DOM-ish shapes; no DOM runtime is used in the extension host.)

- [x] **Step 3: Write `apps/vscode/vite.config.ts`** (CJS extension-host bundle via tsdown; `vscode` is provided by the host so it must be external; bundle the workspace `@t3tools/*` deps, mirroring `apps/desktop/vite.config.ts`)

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // The extension spawns apps/server/dist/bin.mjs, so the server must be built first.
      build: { command: "vp pack", dependsOn: ["t3#build"], cache: false },
      dev: { command: "vp pack --watch", cache: false },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/extension.ts"],
      clean: true,
      // `vscode` is injected by the extension host at runtime — never bundle it.
      external: ["vscode"],
      // Bundle our workspace packages into the extension (they ship no built dist).
      deps: { alwaysBundle: (id: string) => id.startsWith("@t3tools/") },
    },
  ],
});
```

- [x] **Step 4: Write `apps/vscode/.vscodeignore`**

```
src/**
tsconfig.json
vite.config.ts
**/*.test.ts
.vite-plus/**
```

- [x] **Step 5: Write `apps/vscode/README.md`**

```markdown
# @t3tools/vscode-extension

T3 Code as a VSCode extension. Embeds the existing `@t3tools/server` and UI.

## Develop

1. Build the server once: `pnpm build:server` (produces `apps/server/dist/bin.mjs`).
2. Build the extension: `pnpm --filter @t3tools/vscode-extension build`
   (or `pnpm --filter @t3tools/vscode-extension dev` to watch).
3. Open this repo in VSCode and press **F5** (Run Extension) to launch the
   Extension Development Host. Run **T3 Code: Status** from the command palette
   to verify the embedded server is up.

`extensionKind` is `["workspace"]`, so under Remote-SSH the extension and the
server run on the remote host.
```

- [x] **Step 6: Write `apps/vscode/src/logger.ts`**

```ts
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

interface AppendOnlyChannel {
  appendLine(line: string): void;
}

const formatError = (error: unknown): string => {
  if (error === undefined) return "";
  if (error instanceof Error) return ` ${error.stack ?? error.message}`;
  return ` ${String(error)}`;
};

export const createOutputChannelLogger = (channel: AppendOnlyChannel): Logger => ({
  info: (message) => channel.appendLine(`[info] ${message}`),
  warn: (message) => channel.appendLine(`[warn] ${message}`),
  error: (message, error) => channel.appendLine(`[error] ${message}${formatError(error)}`),
});
```

- [x] **Step 7: Write `apps/vscode/src/extension.ts`** (activation stub — replaced with full wiring in Task 7)

```ts
import * as vscode from "vscode";

import { createOutputChannelLogger } from "./logger.ts";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("T3 Code");
  context.subscriptions.push(channel);
  const logger = createOutputChannelLogger(channel);
  logger.info("T3 Code extension activated.");

  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.showStatus", () => {
      void vscode.window.showInformationMessage("T3 Code: status webview not wired yet (Phase 1, Task 7).");
    }),
  );
}

export function deactivate(): void {
  // Supervisor teardown is added in Task 7.
}
```

- [x] **Step 8: Install workspace deps**

Run: `pnpm install`
Expected: completes; `@t3tools/vscode-extension` resolves `@t3tools/contracts` (workspace) and `@types/vscode`.

- [x] **Step 9: Verify it builds and typechecks**

Run: `pnpm --filter @t3tools/vscode-extension build && cd apps/vscode && pnpm typecheck`
Expected: `vp pack` emits `apps/vscode/dist/extension.cjs`; typecheck passes with no errors. Confirm `vscode` is **not** inlined into the bundle:
Run: `grep -c "createOutputChannel" apps/vscode/dist/extension.cjs` → expect `>= 1` (our call survives), and `grep -c "require(\"vscode\")" apps/vscode/dist/extension.cjs` → expect `>= 1` (it is left as an external require).

- [x] **Step 10: Commit**

```bash
git add apps/vscode pnpm-lock.yaml
git commit -m "feat(vscode): scaffold @t3tools/vscode-extension package"
```

---

## Task 2: Free-port scan

**Files:**
- Create: `apps/vscode/src/server/freePort.ts`
- Test: `apps/vscode/src/server/freePort.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `findFreeLoopbackPort(options?: { startPort?: number; maxPort?: number }): Promise<number>` — resolves the first port (default start `3773`, default max `65535`) bindable on both `127.0.0.1` and `::1`; rejects with `Error("No free loopback port found ...")` if none.

- [x] **Step 1: Write the failing test** — `apps/vscode/src/server/freePort.test.ts`

```ts
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/vscode && pnpm test src/server/freePort.test.ts`
Expected: FAIL — `findFreeLoopbackPort` is not defined (module missing).

- [x] **Step 3: Write `apps/vscode/src/server/freePort.ts`**

```ts
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
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/vscode && pnpm test src/server/freePort.test.ts`
Expected: PASS (both tests).

- [x] **Step 5: Commit**

```bash
git add apps/vscode/src/server/freePort.ts apps/vscode/src/server/freePort.test.ts
git commit -m "feat(vscode): add free loopback port scan"
```

---

## Task 3: Bootstrap envelope builder + fd-3 line

**Files:**
- Create: `apps/vscode/src/server/bootstrap.ts`
- Test: `apps/vscode/src/server/bootstrap.test.ts`

**Interfaces:**
- Consumes: `DesktopBackendBootstrap` **type** from `@t3tools/contracts` (type-only import).
- Produces:
  - `mintBootstrapToken(randomBytes?: (n: number) => Buffer): string` — 48-hex-char token (24 random bytes), `node:crypto` by default; the param is for deterministic tests.
  - `buildBootstrap(input: { port: number; host: string; t3Home: string; token: string }): DesktopBackendBootstrap` — fills the full envelope with the local-only defaults (`mode: "desktop"`, `noBrowser: true`, tailscale disabled).
  - `serializeBootstrapLine(bootstrap: DesktopBackendBootstrap): string` — the exact newline-terminated JSON written to fd 3.

- [x] **Step 1: Write the failing test** — `apps/vscode/src/server/bootstrap.test.ts`

```ts
import { describe, expect, it } from "vite-plus/test";

import { buildBootstrap, mintBootstrapToken, serializeBootstrapLine } from "./bootstrap.ts";

describe("bootstrap", () => {
  it("mints a 48-char hex token from 24 random bytes", () => {
    const token = mintBootstrapToken((n) => Buffer.alloc(n, 0xab));
    expect(token).toBe("ab".repeat(24));
    expect(token).toHaveLength(48);
  });

  it("builds the local-only desktop bootstrap envelope", () => {
    const bootstrap = buildBootstrap({ port: 3773, host: "127.0.0.1", t3Home: "/home/u/.t3", token: "tok" });
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/vscode && pnpm test src/server/bootstrap.test.ts`
Expected: FAIL — module/exports missing.

- [x] **Step 3: Write `apps/vscode/src/server/bootstrap.ts`**

```ts
import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { DesktopBackendBootstrap } from "@t3tools/contracts";

export const mintBootstrapToken = (
  randomBytes: (n: number) => Buffer = nodeRandomBytes,
): string => randomBytes(24).toString("hex");

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
  tailscaleServePort: 0,
});

export const serializeBootstrapLine = (bootstrap: DesktopBackendBootstrap): string =>
  `${JSON.stringify(bootstrap)}\n`;
```

Note: `tailscaleServePort: 0` satisfies the required `PortSchema` field while signalling "unused" alongside `tailscaleServeEnabled: false`. If `PortSchema` rejects `0` at server decode time, change to `1` — verify against the real server in Task 7's manual smoke (the server ignores it when `tailscaleServeEnabled` is false).

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/vscode && pnpm test src/server/bootstrap.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/vscode/src/server/bootstrap.ts apps/vscode/src/server/bootstrap.test.ts
git commit -m "feat(vscode): add bootstrap envelope builder for fd-3 handshake"
```

---

## Task 4: Server entry resolver (node exec + bin path)

**Files:**
- Create: `apps/vscode/src/server/serverEntry.ts`
- Test: `apps/vscode/src/server/serverEntry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveServerEntry(input: { extensionPath: string; execPath: string; fileExists: (p: string) => boolean }): { command: string; entryPath: string; spawnEnv: Record<string, string> }` — picks the server bin (packaged copy `<extensionPath>/server/dist/bin.mjs` if present, else monorepo dev path `<extensionPath>/../../apps/server/dist/bin.mjs`), returns the Node `command` (`execPath`) and the `ELECTRON_RUN_AS_NODE=1` env so the host's Electron/Node binary runs as plain Node (the same trick the desktop app and VSCode itself use). Throws `Error` if no bin is found.

- [x] **Step 1: Write the failing test** — `apps/vscode/src/server/serverEntry.test.ts`

```ts
import { describe, expect, it } from "vite-plus/test";
import * as path from "node:path";

import { resolveServerEntry } from "./serverEntry.ts";

const ext = "/opt/ext/t3code";
const packaged = path.join(ext, "server", "dist", "bin.mjs");
const dev = path.resolve(ext, "..", "..", "apps", "server", "dist", "bin.mjs");

describe("resolveServerEntry", () => {
  it("prefers the packaged server bin when present", () => {
    const r = resolveServerEntry({ extensionPath: ext, execPath: "/usr/bin/node", fileExists: (p) => p === packaged });
    expect(r.entryPath).toBe(packaged);
    expect(r.command).toBe("/usr/bin/node");
    expect(r.spawnEnv.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("falls back to the monorepo dev path", () => {
    const r = resolveServerEntry({ extensionPath: ext, execPath: "/usr/bin/node", fileExists: (p) => p === dev });
    expect(r.entryPath).toBe(dev);
  });

  it("throws when no server bin exists", () => {
    expect(() => resolveServerEntry({ extensionPath: ext, execPath: "/usr/bin/node", fileExists: () => false })).toThrow(
      /server bin not found/i,
    );
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/vscode && pnpm test src/server/serverEntry.test.ts`
Expected: FAIL — module missing.

- [x] **Step 3: Write `apps/vscode/src/server/serverEntry.ts`**

```ts
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
    throw new Error(`Server bin not found. Looked in:\n  ${packaged}\n  ${dev}\nRun \`pnpm build:server\`.`);
  }
  return {
    command: input.execPath,
    entryPath,
    // Run the host's Electron/Node binary as plain Node so the child is not a GUI instance.
    spawnEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
};
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/vscode && pnpm test src/server/serverEntry.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/vscode/src/server/serverEntry.ts apps/vscode/src/server/serverEntry.test.ts
git commit -m "feat(vscode): resolve server child entry path and node command"
```

---

## Task 5: Server supervisor (spawn + fd-3 + readiness + backoff + stop)

This is the core of the phase. All effects are injected so it runs headless. Constants mirror the desktop supervisor: initial restart delay 500ms, max 10s, readiness timeout 60s, readiness interval 100ms, terminate grace 2s.

**Files:**
- Create: `apps/vscode/src/server/serverSupervisor.ts`
- Test: `apps/vscode/src/server/serverSupervisor.test.ts`

**Interfaces:**
- Consumes: `Logger` (`src/logger.ts`); `findFreeLoopbackPort` (Task 2); `mintBootstrapToken`/`buildBootstrap`/`serializeBootstrapLine` (Task 3); `ResolvedServerEntry` (Task 4).
- Produces:
  - Types:
    ```ts
    interface SpawnedChild {
      readonly pid: number | undefined;
      writeBootstrap(line: string): void;   // writes to fd 3 then ends that stream
      kill(signal: NodeJS.Signals): void;
      onExit(cb: (code: number | null) => void): void;
    }
    interface SupervisorDeps {
      readonly logger: Logger;
      readonly findFreePort: (opts?: { startPort?: number }) => Promise<number>;
      readonly resolveEntry: () => { command: string; entryPath: string; spawnEnv: Record<string, string> };
      readonly t3Home: string;
      readonly host?: string;                // default "127.0.0.1"
      readonly spawn: (cmd: string, args: readonly string[], opts: { cwd: string; env: Record<string, string | undefined> }) => SpawnedChild;
      readonly probeReady: (httpBaseUrl: string, signal: AbortSignal) => Promise<boolean>;
      readonly sleep: (ms: number) => Promise<void>;
      readonly now: () => number;
      readonly tuning?: Partial<SupervisorTuning>;
    }
    interface SupervisorTuning {
      initialRestartDelayMs: number; maxRestartDelayMs: number;
      readinessTimeoutMs: number; readinessIntervalMs: number; terminateGraceMs: number;
    }
    interface ServerHandle {
      readonly port: number;
      readonly httpBaseUrl: string;          // http://<host>:<port>
      readonly token: string;
    }
    ```
  - `createServerSupervisor(deps: SupervisorDeps): { start(): Promise<ServerHandle>; stop(): Promise<void>; snapshot(): { running: boolean; ready: boolean; restartAttempt: number } }`
  - `restartDelay(attempt: number, tuning: SupervisorTuning): number` (exported pure helper: `min(initial * 2**attempt, max)`).

- [x] **Step 1: Write the failing test** — `apps/vscode/src/server/serverSupervisor.test.ts`

```ts
import { describe, expect, it, vi } from "vite-plus/test";

import { createServerSupervisor, restartDelay } from "./serverSupervisor.ts";
import { createOutputChannelLogger } from "../logger.ts";

const tuning = {
  initialRestartDelayMs: 10, maxRestartDelayMs: 100,
  readinessTimeoutMs: 1000, readinessIntervalMs: 5, terminateGraceMs: 20,
};
const logger = createOutputChannelLogger({ appendLine: () => {} });

interface FakeChild {
  pid: number | undefined;
  written: string[];
  killed: NodeJS.Signals[];
  exit: (code: number | null) => void;
}

const makeDeps = (overrides: { probeReady?: () => Promise<boolean> } = {}) => {
  const children: FakeChild[] = [];
  const spawn = () => {
    let onExit: ((code: number | null) => void) | undefined;
    const child: FakeChild = {
      pid: 100 + children.length,
      written: [],
      killed: [],
      exit: (code) => onExit?.(code),
    };
    children.push(child);
    return {
      pid: child.pid,
      writeBootstrap: (line: string) => child.written.push(line),
      kill: (sig: NodeJS.Signals) => child.killed.push(sig),
      onExit: (cb: (code: number | null) => void) => { onExit = cb; },
    };
  };
  const deps = {
    logger,
    findFreePort: async () => 3801,
    resolveEntry: () => ({ command: "node", entryPath: "/bin.mjs", spawnEnv: { ELECTRON_RUN_AS_NODE: "1" } }),
    t3Home: "/home/u/.t3",
    spawn,
    probeReady: overrides.probeReady ?? (async () => true),
    sleep: async () => {},
    now: () => 0,
    tuning,
  };
  return { deps, children };
};

describe("restartDelay", () => {
  it("doubles per attempt and caps at max", () => {
    const t = { initialRestartDelayMs: 500, maxRestartDelayMs: 10000, readinessTimeoutMs: 0, readinessIntervalMs: 0, terminateGraceMs: 0 };
    expect(restartDelay(0, t)).toBe(500);
    expect(restartDelay(1, t)).toBe(1000);
    expect(restartDelay(5, t)).toBe(10000); // 500*32 capped
  });
});

describe("createServerSupervisor", () => {
  it("spawns the child with --bootstrap-fd 3 and writes the bootstrap line to fd 3", async () => {
    const { deps, children } = makeDeps();
    const spawnSpy = vi.spyOn(deps, "spawn");
    const supervisor = createServerSupervisor(deps);
    const handle = await supervisor.start();

    expect(handle.port).toBe(3801);
    expect(handle.httpBaseUrl).toBe("http://127.0.0.1:3801");
    const [, args] = spawnSpy.mock.calls[0]!;
    expect(args).toEqual(["/bin.mjs", "--bootstrap-fd", "3"]);
    const line = children[0]!.written[0]!;
    expect(JSON.parse(line) as { desktopBootstrapToken: string }).toMatchObject({
      port: 3801, host: "127.0.0.1", desktopBootstrapToken: handle.token,
    });
    expect(supervisor.snapshot()).toMatchObject({ running: true, ready: true });
    await supervisor.stop();
  });

  it("auto-restarts with backoff when the child exits unexpectedly", async () => {
    const { deps, children } = makeDeps();
    const sleepSpy = vi.spyOn(deps, "sleep");
    const supervisor = createServerSupervisor(deps);
    await supervisor.start();
    expect(children).toHaveLength(1);

    // Simulate a crash.
    children[0]!.exit(1);
    // Let the restart microtasks settle.
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(children.length).toBe(2));
    expect(sleepSpy).toHaveBeenCalledWith(tuning.initialRestartDelayMs);
    await supervisor.stop();
  });

  it("stop() sends SIGTERM and suppresses restart", async () => {
    const { deps, children } = makeDeps();
    const supervisor = createServerSupervisor(deps);
    await supervisor.start();
    await supervisor.stop();
    expect(children[0]!.killed).toContain("SIGTERM");
    children[0]!.exit(0); // exit after stop must NOT spawn a replacement
    await new Promise((r) => setTimeout(r, 0));
    expect(children).toHaveLength(1);
  });

  it("rejects start() if readiness never succeeds before timeout", async () => {
    const { deps } = makeDeps({ probeReady: async () => false });
    const supervisor = createServerSupervisor({ ...deps, now: (() => { let t = 0; return () => (t += 100); })() });
    await expect(supervisor.start()).rejects.toThrow(/readiness|timed out/i);
    await supervisor.stop();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/vscode && pnpm test src/server/serverSupervisor.test.ts`
Expected: FAIL — module/exports missing.

- [x] **Step 3: Write `apps/vscode/src/server/serverSupervisor.ts`**

```ts
import type { Logger } from "../logger.ts";
import { buildBootstrap, mintBootstrapToken, serializeBootstrapLine } from "./bootstrap.ts";

export interface SpawnedChild {
  readonly pid: number | undefined;
  writeBootstrap(line: string): void;
  kill(signal: NodeJS.Signals): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface SupervisorTuning {
  initialRestartDelayMs: number;
  maxRestartDelayMs: number;
  readinessTimeoutMs: number;
  readinessIntervalMs: number;
  terminateGraceMs: number;
}

const DEFAULT_TUNING: SupervisorTuning = {
  initialRestartDelayMs: 500,
  maxRestartDelayMs: 10_000,
  readinessTimeoutMs: 60_000,
  readinessIntervalMs: 100,
  terminateGraceMs: 2_000,
};

export interface ResolvedEntryLite {
  readonly command: string;
  readonly entryPath: string;
  readonly spawnEnv: Record<string, string>;
}

export interface SupervisorDeps {
  readonly logger: Logger;
  readonly findFreePort: (opts?: { startPort?: number }) => Promise<number>;
  readonly resolveEntry: () => ResolvedEntryLite;
  readonly t3Home: string;
  readonly host?: string;
  readonly spawn: (
    cmd: string,
    args: readonly string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
  ) => SpawnedChild;
  readonly probeReady: (httpBaseUrl: string, signal: AbortSignal) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly tuning?: Partial<SupervisorTuning>;
}

export interface ServerHandle {
  readonly port: number;
  readonly httpBaseUrl: string;
  readonly token: string;
}

export const restartDelay = (attempt: number, tuning: SupervisorTuning): number =>
  Math.min(tuning.initialRestartDelayMs * 2 ** attempt, tuning.maxRestartDelayMs);

export const createServerSupervisor = (deps: SupervisorDeps) => {
  const tuning: SupervisorTuning = { ...DEFAULT_TUNING, ...deps.tuning };
  const host = deps.host ?? "127.0.0.1";
  const token = mintBootstrapToken();

  let desiredRunning = false;
  let ready = false;
  let restartAttempt = 0;
  let current: SpawnedChild | null = null;
  let currentPort = 0;

  const waitForReady = async (httpBaseUrl: string): Promise<void> => {
    const deadline = deps.now() + tuning.readinessTimeoutMs;
    while (deps.now() < deadline) {
      const controller = new AbortController();
      const ok = await deps.probeReady(httpBaseUrl, controller.signal).catch(() => false);
      if (ok) return;
      await deps.sleep(tuning.readinessIntervalMs);
    }
    throw new Error(`Server readiness timed out after ${tuning.readinessTimeoutMs}ms at ${httpBaseUrl}`);
  };

  const launch = async (): Promise<ServerHandle> => {
    const entry = deps.resolveEntry();
    currentPort = await deps.findFreePort({ startPort: 3773 });
    const httpBaseUrl = `http://${host}:${currentPort}`;
    const bootstrap = buildBootstrap({ port: currentPort, host, t3Home: deps.t3Home, token });

    const child = deps.spawn(entry.command, [entry.entryPath, "--bootstrap-fd", "3"], {
      cwd: deps.t3Home,
      env: { ...process.env, ...entry.spawnEnv },
    });
    current = child;
    deps.logger.info(`Spawned server pid=${String(child.pid)} port=${currentPort}`);
    child.writeBootstrap(serializeBootstrapLine(bootstrap));
    child.onExit((code) => {
      ready = false;
      if (child === current) current = null;
      if (!desiredRunning) return;
      void scheduleRestart(code);
    });

    await waitForReady(httpBaseUrl);
    ready = true;
    restartAttempt = 0;
    deps.logger.info(`Server ready at ${httpBaseUrl}`);
    return { port: currentPort, httpBaseUrl, token };
  };

  const scheduleRestart = async (code: number | null): Promise<void> => {
    const delay = restartDelay(restartAttempt, tuning);
    deps.logger.warn(`Server exited (code=${String(code)}); restarting in ${delay}ms (attempt ${restartAttempt + 1})`);
    restartAttempt += 1;
    await deps.sleep(delay);
    if (!desiredRunning) return;
    try {
      await launch();
    } catch (error) {
      deps.logger.error("Server restart failed", error);
      if (desiredRunning) void scheduleRestart(null);
    }
  };

  const start = async (): Promise<ServerHandle> => {
    desiredRunning = true;
    return launch();
  };

  const stop = async (): Promise<void> => {
    desiredRunning = false;
    const child = current;
    if (child === null) return;
    child.kill("SIGTERM");
    await deps.sleep(tuning.terminateGraceMs);
  };

  const snapshot = () => ({ running: desiredRunning, ready, restartAttempt });

  return { start, stop, snapshot };
};
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/vscode && pnpm test src/server/serverSupervisor.test.ts`
Expected: PASS (all 5 cases).

- [x] **Step 5: Commit**

```bash
git add apps/vscode/src/server/serverSupervisor.ts apps/vscode/src/server/serverSupervisor.test.ts
git commit -m "feat(vscode): add server supervisor with fd-3 handshake and backoff restart"
```

---

## Task 6: URL resolver (asExternalUri wrapper)

**Files:**
- Create: `apps/vscode/src/transport/urlResolver.ts`
- Test: `apps/vscode/src/transport/urlResolver.test.ts`

**Interfaces:**
- Consumes: nothing (the VSCode `asExternalUri` is injected as a plain async function so this is testable without `vscode`).
- Produces:
  - `resolveExternalBaseUrls(input: { localHttpBaseUrl: string; asExternalUri: (url: string) => Promise<string> }): Promise<{ httpBaseUrl: string; wsBaseUrl: string; readinessUrl: string }>` — calls `asExternalUri` on the loopback http URL (identity locally, forwarded under Remote-SSH), derives the `ws`/`wss` base (`http→ws`, `https→wss`), and the readiness URL (`<httpBaseUrl>/.well-known/t3/environment`).

- [x] **Step 1: Write the failing test** — `apps/vscode/src/transport/urlResolver.test.ts`

```ts
import { describe, expect, it } from "vite-plus/test";

import { resolveExternalBaseUrls } from "./urlResolver.ts";

describe("resolveExternalBaseUrls", () => {
  it("returns the loopback URL unchanged locally and derives ws + readiness", async () => {
    const r = await resolveExternalBaseUrls({
      localHttpBaseUrl: "http://127.0.0.1:3801",
      asExternalUri: async (u) => u,
    });
    expect(r.httpBaseUrl).toBe("http://127.0.0.1:3801");
    expect(r.wsBaseUrl).toBe("ws://127.0.0.1:3801");
    expect(r.readinessUrl).toBe("http://127.0.0.1:3801/.well-known/t3/environment");
  });

  it("honours a forwarded https URL under Remote-SSH and yields wss", async () => {
    const r = await resolveExternalBaseUrls({
      localHttpBaseUrl: "http://127.0.0.1:3801",
      asExternalUri: async () => "https://abc-3801.vscode-cdn.example/",
    });
    expect(r.httpBaseUrl).toBe("https://abc-3801.vscode-cdn.example");
    expect(r.wsBaseUrl).toBe("wss://abc-3801.vscode-cdn.example");
    expect(r.readinessUrl).toBe("https://abc-3801.vscode-cdn.example/.well-known/t3/environment");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/vscode && pnpm test src/transport/urlResolver.test.ts`
Expected: FAIL — module missing.

- [x] **Step 3: Write `apps/vscode/src/transport/urlResolver.ts`**

```ts
export interface ResolveExternalBaseUrlsInput {
  readonly localHttpBaseUrl: string;
  readonly asExternalUri: (url: string) => Promise<string>;
}

export interface ResolvedBaseUrls {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly readinessUrl: string;
}

const stripTrailingSlash = (value: string): string => (value.endsWith("/") ? value.slice(0, -1) : value);

export const resolveExternalBaseUrls = async (
  input: ResolveExternalBaseUrlsInput,
): Promise<ResolvedBaseUrls> => {
  const external = await input.asExternalUri(input.localHttpBaseUrl);
  const url = new URL(external);
  const httpBaseUrl = stripTrailingSlash(url.toString());
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  const wsBaseUrl = stripTrailingSlash(`${wsScheme}//${url.host}${url.pathname}`);
  const readinessUrl = `${httpBaseUrl}/.well-known/t3/environment`;
  return { httpBaseUrl, wsBaseUrl, readinessUrl };
};
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/vscode && pnpm test src/transport/urlResolver.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/vscode/src/transport/urlResolver.ts apps/vscode/src/transport/urlResolver.test.ts
git commit -m "feat(vscode): resolve external server URLs via asExternalUri"
```

---

## Task 7: Wire activation + minimal status webview (end-to-end verification)

Wires the pure modules to real VSCode APIs and proves connectivity. The status webview fetches `/.well-known/t3/environment` (via the resolved external URL) and renders the descriptor — the Phase 1 acceptance signal, working both locally and under Remote-SSH.

**Files:**
- Create: `apps/vscode/src/ui/statusPanel.ts`
- Test: `apps/vscode/src/ui/statusPanel.test.ts`
- Modify: `apps/vscode/src/extension.ts` (replace the Task 1 stub with full wiring)

**Interfaces:**
- Consumes: `createServerSupervisor` (Task 5), `findFreeLoopbackPort` (Task 2), `resolveServerEntry` (Task 4), `resolveExternalBaseUrls` (Task 6), `createOutputChannelLogger` (Task 1).
- Produces: `renderStatusHtml(input: { ready: boolean; httpBaseUrl: string; wsBaseUrl: string; descriptorJson: string | null; error: string | null }): string` from `ui/statusPanel.ts` (pure, no `vscode`); a working `activate`/`deactivate`.

- [x] **Step 1: Write the failing test** — `apps/vscode/src/ui/statusPanel.test.ts`

```ts
import { describe, expect, it } from "vite-plus/test";

import { renderStatusHtml } from "./statusPanel.ts";

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

  it("escapes HTML in the error to avoid injection", () => {
    const html = renderStatusHtml({
      ready: false, httpBaseUrl: "", wsBaseUrl: "", descriptorJson: null,
      error: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/vscode && pnpm test src/ui/statusPanel.test.ts`
Expected: FAIL — module missing.

- [x] **Step 3: Write `apps/vscode/src/ui/statusPanel.ts`**

```ts
export interface StatusViewModel {
  readonly ready: boolean;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly descriptorJson: string | null;
  readonly error: string | null;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const renderStatusHtml = (model: StatusViewModel): string => {
  const status = model.error !== null ? "Error" : model.ready ? "Ready" : "Starting…";
  const body =
    model.error !== null
      ? `<p class="err">${escapeHtml(model.error)}</p>`
      : `<dl>
           <dt>HTTP</dt><dd>${escapeHtml(model.httpBaseUrl)}</dd>
           <dt>WebSocket</dt><dd>${escapeHtml(model.wsBaseUrl)}</dd>
           <dt>Descriptor</dt><dd><pre>${escapeHtml(model.descriptorJson ?? "(none)")}</pre></dd>
         </dl>`;
  return `<!doctype html><html><head><meta charset="utf-8" />
    <style>body{font-family:var(--vscode-font-family);padding:12px}.err{color:var(--vscode-errorForeground)}
    dt{font-weight:600;margin-top:8px}pre{white-space:pre-wrap}</style></head>
    <body><h2>T3 Code — ${escapeHtml(status)}</h2>${body}</body></html>`;
};
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/vscode && pnpm test src/ui/statusPanel.test.ts`
Expected: PASS.

- [x] **Step 5: Replace `apps/vscode/src/extension.ts` with full wiring**

```ts
import * as fs from "node:fs";

import * as vscode from "vscode";

import { createOutputChannelLogger } from "./logger.ts";
import { findFreeLoopbackPort } from "./server/freePort.ts";
import { resolveServerEntry } from "./server/serverEntry.ts";
import {
  createServerSupervisor,
  type ServerHandle,
  type SpawnedChild,
} from "./server/serverSupervisor.ts";
import { resolveExternalBaseUrls } from "./transport/urlResolver.ts";
import { renderStatusHtml, type StatusViewModel } from "./ui/statusPanel.ts";
import { spawn as nodeSpawn } from "node:child_process";

let supervisor: ReturnType<typeof createServerSupervisor> | null = null;
let handle: ServerHandle | null = null;

const spawnChild = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
): SpawnedChild => {
  const child = nodeSpawn(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe", "pipe"], // fd 3 = bootstrap pipe
  });
  return {
    pid: child.pid,
    writeBootstrap: (line) => {
      const fd3 = child.stdio[3];
      if (fd3 !== null && fd3 !== undefined && "write" in fd3) {
        (fd3 as NodeJS.WritableStream).write(line);
        (fd3 as NodeJS.WritableStream).end();
      }
    },
    kill: (signal) => child.kill(signal),
    onExit: (cb) => child.on("exit", (code) => cb(code)),
  };
};

const probeReady = async (httpBaseUrl: string, signal: AbortSignal): Promise<boolean> => {
  try {
    const res = await fetch(`${httpBaseUrl}/.well-known/t3/environment`, { signal });
    return res.ok;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel("T3 Code");
  context.subscriptions.push(channel);
  const logger = createOutputChannelLogger(channel);
  logger.info("T3 Code extension activating.");

  const t3Home = `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.t3`;

  supervisor = createServerSupervisor({
    logger,
    findFreePort: findFreeLoopbackPort,
    resolveEntry: () =>
      resolveServerEntry({
        extensionPath: context.extensionPath,
        execPath: process.execPath,
        fileExists: (p) => fs.existsSync(p),
      }),
    t3Home,
    spawn: spawnChild,
    probeReady,
    sleep,
    now: () => performance.now(),
  });

  try {
    handle = await supervisor.start();
    logger.info(`Server up at ${handle.httpBaseUrl}`);
  } catch (error) {
    logger.error("Failed to start the T3 Code server", error);
    void vscode.window.showErrorMessage("T3 Code: failed to start the embedded server. See the T3 Code output channel.");
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.showStatus", async () => {
      const panel = vscode.window.createWebviewPanel("t3codeStatus", "T3 Code: Status", vscode.ViewColumn.Active, {});
      const model = await buildStatusModel();
      panel.webview.html = renderStatusHtml(model);
    }),
  );
}

const buildStatusModel = async (): Promise<StatusViewModel> => {
  if (handle === null) {
    return { ready: false, httpBaseUrl: "", wsBaseUrl: "", descriptorJson: null, error: "Server is not running." };
  }
  try {
    const resolved = await resolveExternalBaseUrls({
      localHttpBaseUrl: handle.httpBaseUrl,
      asExternalUri: async (u) => (await vscode.env.asExternalUri(vscode.Uri.parse(u))).toString(),
    });
    const res = await fetch(resolved.readinessUrl);
    const descriptorJson = res.ok ? JSON.stringify(JSON.parse(await res.text()), null, 2) : null;
    return {
      ready: res.ok,
      httpBaseUrl: resolved.httpBaseUrl,
      wsBaseUrl: resolved.wsBaseUrl,
      descriptorJson,
      error: res.ok ? null : `Descriptor fetch failed: HTTP ${String(res.status)}`,
    };
  } catch (error) {
    return {
      ready: false, httpBaseUrl: handle.httpBaseUrl, wsBaseUrl: "", descriptorJson: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export async function deactivate(): Promise<void> {
  await supervisor?.stop();
  supervisor = null;
  handle = null;
}
```

- [x] **Step 6: Typecheck + build + full package test run**

Run: `cd apps/vscode && pnpm typecheck && pnpm test && pnpm build`
Expected: typecheck clean; all unit tests pass; `dist/extension.cjs` emitted.

- [x] **Step 7: Manual smoke in the Extension Development Host (records evidence)**

This is the Phase 1 acceptance test — it exercises the real `vscode` API and a real server child, which the unit tests deliberately mock.

1. `pnpm build:server` (ensure `apps/server/dist/bin.mjs` exists). **PASS**
2. `pnpm --filter t3-code build`. **PASS**
3. Open the repo in VSCode → **Run and Debug** → **Run Extension** (F5). **PASS**
4. In the dev host window, open the **T3 Code** output channel — confirm `Spawned server …` then `Server ready at http://127.0.0.1:<port>`. **PASS**
5. Run **T3 Code: Status** from the command palette — confirm the webview shows `Ready`, the http/ws URLs, and a descriptor JSON containing `environmentId`, `serverVersion`, `platform`. **PASS** (operator-verified on `http://127.0.0.1:3774`)
6. Kill the server child externally (`kill <pid>` from the output log) — confirm the output channel shows a backoff restart and a new `Server ready` line. **PASS** (headless: `pnpm --filter t3-code smoke-test`, kill → new pid + readiness)
7. Close the dev host window — confirm the server child exits (no orphaned `bin.mjs` process). **PASS** (headless smoke: `supervisor.stop()` / deactivate path, no live pids after 3s)
8. **(If a Remote-SSH host is available)** repeat 3–5 in a Remote-SSH window; confirm the descriptor still loads and the status webview shows a forwarded `https`/`wss` URL. **NOT RUN** (optional; unit tests cover `asExternalUri` wiring)

Record pass/fail for each step in the commit message or PR description. If `tailscaleServePort: 0` was rejected by the server at decode time (watch the output channel for a bootstrap decode error), change it to `1` in `bootstrap.ts` per Task 3's note and re-run.

- [x] **Step 8: Commit**

```bash
git add apps/vscode/src/extension.ts apps/vscode/src/ui/statusPanel.ts apps/vscode/src/ui/statusPanel.test.ts
git commit -m "feat(vscode): wire activation, supervisor lifecycle, and status webview"
```

---

## Phase 1 Self-Review

- **Spec coverage (Phase 1 slice):** package layout (`apps/vscode`, `@t3tools/vscode-extension`, `apps/*` glob, two-target build — only the extension-host target exists this phase; the webview target arrives in Phase 2) ✓ Task 1; server lifecycle (free-port scan, fd-3 handshake, readiness poll on `/.well-known/t3/environment`, exp-backoff restart, graceful SIGTERM) ✓ Tasks 2–5; transport URL resolution via `asExternalUri` for local + Remote-SSH ✓ Task 6; `extensionKind: ["workspace"]` ✓ Task 1; local-only bootstrap-token auth, no Clerk/Tailscale/relay ✓ Task 3. Out of scope this phase (deferred to roadmap): webview UI reuse, client-runtime transport, selection broker, native bridge.
- **No-dependency-on-desktop constraint:** honored — only the `DesktopBackendBootstrap` type and the wire protocol are reused; no `apps/desktop/**` or Effect import.
- **Placeholder scan:** none — every step ships real code/tests/commands.
- **Type consistency:** `ServerHandle`/`SpawnedChild`/`SupervisorDeps` names are consistent between Task 5's definition and Task 7's import; `resolveServerEntry`'s return shape matches `SupervisorDeps.resolveEntry`'s `ResolvedEntryLite`.

---

## Roadmap — Phases 2–4 (to be planned in their own files when reached)

Each phase is independently testable and gets its own `docs/superpowers/plans/` file authored at the start of that phase (not now — later phases will be informed by what Phase 1 implementation reveals). Decisions are already locked by the approved design spec (`docs/superpowers/specs/2026-06-30-vscode-extension-design.md`); these are scope sketches, not plans.

### Phase 2 — Webview host + transport + first reused webview (live chat)
- Add the **second build target**: a Vite webview bundle (same toolchain as `apps/web`) emitted into `apps/vscode/dist/webview/`, loaded into a `WebviewView`/`WebviewPanel` with a CSP whose `connect-src` includes the resolved ws/http origin.
- Add `isVSCode` to `apps/web/src/env.ts` (alongside `isElectron`, sniffing the webview global), and extend the history ternary in `apps/web/src/main.ts` to `isElectron || isVSCode` → `createHashHistory()`.
- Add an `exports` field to `@t3tools/web` (it has none today — mirror `@t3tools/client-runtime`'s source-only exports map) so `apps/vscode` can import its components + provider stack.
- Boot a trimmed web provider stack inside the webview pointed at the resolved ws URL via `@t3tools/client-runtime` (`WsTransport` + `createWsRpcClient`, unchanged); inject the URL + bootstrap token into the webview at construction (analogous to desktop's `window.desktopBridge.getLocalEnvironmentBootstrap()` — a VSCode-injected global the web target resolver in `apps/web/src/environments/primary/target.ts` learns to read).
- Render `ChatView` (surface #2) for a thread. **Deliverable:** open a session and chat inside VSCode.

### Phase 3 — Remaining webviews + extension-host selection broker
- Surfaces #1 (sidebar: session list + subagent tree, `Sidebar` + `SubagentWatchView`, scoped to `workspace.workspaceFolders[0]`), #3 (settings editor tab), #4 (comment-able diff, `DiffPanel` + `DiffWorkerPoolProvider`, re-themed via the `--diffs-*` vars).
- The **extension-host selection broker**: holds active env/thread + open-diff/open-settings intents, broadcasts over `postMessage`, replays current selection to newly (re)loaded webviews.
- Re-theme via CSS-variable overrides mapping the web token layer (`--background`, `--foreground`, …) + `--diffs-*` to VSCode theme vars. **Deliverable:** all four webviews working and coordinated.

### Phase 4 — Native bridge
- `postMessage` → extension host → VSCode APIs implementing the needed slice of `LocalApi`/`EnvironmentApi` (`packages/contracts/src/ipc.ts`): `context.secrets` (provider keys/tokens), `showOpenDialog`, theme tokens, `env.openExternal`, `showTextDocument`, `createTerminal`, `workspace.workspaceFolders[0]`.
- Delegate to native VSCode: interactive terminal, file opens, SCM status. Keep custom: comment-able diff, chat, list+tree, settings. **Deliverable:** secrets, pickers, file/terminal opens work natively.

### Phase 1→2 packaging (resolved)

- **VSIX packaging:** `pnpm --filter t3-code package:vsix` runs `vscode:prepublish` (build extension + `stageServerDist.ts` copy of `apps/server/dist`) and `vsce package --no-dependencies`. Staged `apps/vscode/server/` and `*.vsix` are gitignored.
- **Distribution:** internal/dev VSIX for now; marketplace publishing deferred to a later phase.
