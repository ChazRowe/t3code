# VSCode Extension — Phase 2: Webview Host + Transport + Live Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the second build target — a Vite webview bundle loaded into a sidebar `WebviewView` — that connects to the embedded server over a direct WebSocket (via `@t3tools/client-runtime`, unchanged), bootstraps with the supervisor's local auth token, and renders the reused `ChatView` so an operator can open a session and chat inside VSCode (local Extension Development Host; Remote-SSH optional manual smoke).

**Architecture:** Phase 1's extension host still owns server lifecycle and URL resolution (`asExternalUri`). Phase 2 adds (a) a **pure webview HTML builder** that injects a minimal `window.vscodeBridge.getLocalEnvironmentBootstrap()` before the bundle loads, with a CSP whose `connect-src` includes the resolved http/ws origins; (b) a **Vite webview bundle** (`apps/vscode/dist/webview/chat/`) whose entry mounts a trimmed **`VsCodeChatShell`** in `@t3tools/web` — QueryClient + environment connection service + auth bootstrap + welcome handler + `ChatView`, without the full TanStack Router tree or sidebar; (c) a **`ChatWebviewViewProvider`** registered in `extension.ts`. Native bridge (secrets, pickers, terminals) stays Phase 4; selection broker stays Phase 3. Full VSCode-token re-theming is Phase 3 — Phase 2 ships minimal inherited webview chrome plus `--vscode-font-family` / error foreground on shell states.

**Tech Stack:** TypeScript (NodeNext, strict), VSCode Extension API (`engines.vscode ^1.90.0`), Vite via `vite-plus` for the webview SPA, React 19 + Tailwind 4 (same as `apps/web`), `@t3tools/web` (workspace, source exports), `@t3tools/client-runtime`, `@t3tools/contracts`. Extension host bundle remains CJS via `vp pack`. Tests: Vitest via `vite-plus/test`.

## Global Constraints

These apply to **every task**. Values copied verbatim from the approved design spec and Phase 1 plan.

- **Package name:** `t3-code` (`@t3tools/vscode-extension` workspace alias), `"private": true`, `"type": "module"`. **`extensionKind`:** `["workspace"]`.
- **No dependency on `@t3tools/desktop`.** Reuse contracts + client-runtime + web components only.
- **Local-only auth.** Bootstrap token from supervisor handle; `mode: "desktop"` on the server fd-3 envelope (unchanged from Phase 1). No Clerk in the VSCode webview path (`VITE_CLERK_PUBLISHABLE_KEY` unset → `main.tsx`-equivalent path skips Clerk).
- **Transport:** direct WebSocket from webview to server via `@t3tools/client-runtime` (`WsTransport` + `createWsRpcClient`). URL + token injected at webview construction through `vscodeBridge`, consumed by `apps/web/src/environments/primary/target.ts` and `auth.ts` (same shape as `DesktopEnvironmentBootstrap`).
- **TS config (inherited):** `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, relative imports with `.ts` extension in extension-host code, `erasableSyntaxOnly` (no `enum`).
- **Repo lint:** no `console.*` in committed code — extension host logs through `OutputChannel` / injected `Logger`. No `crypto.randomUUID()` — use `randomBytes` + hex.
- **Verification before completion:** `vp check` and `vp run typecheck` must pass; `pnpm --filter t3-code test` for extension unit tests; manual F5 smoke for live chat send.
- **Non-goals this phase:** selection broker, settings/diff/list webviews, native bridge, full VSCode CSS-token remapping, marketplace publish, browser-based VSCode (vscode.dev).

---

## File Structure (created or modified by this phase)

```
apps/web/
  package.json                          # add exports map for vscode entrypoints
  src/
    env.ts                              # add isVSCode
    vite-env.d.ts                       # window.vscodeBridge type
    environments/primary/
      target.ts                         # resolveVsCodePrimaryTarget()
      target.test.ts                    # vscode bootstrap cases
      auth.ts                           # read vscodeBridge bootstrap token
      auth.test.ts                      # extend desktop token test
    vscode/
      bridge.ts                         # VsCodeBridge interface + reader
      chatShell.tsx                     # trimmed provider stack + ChatView mount
      chatShell.test.tsx                # bootstrap-gate unit test (mock bridge)
      main.tsx                          # webview entry (imported by vscode vite build)

apps/vscode/
  package.json                          # web deps, build:webview, manifest contributions
  vite.config.ts                        # extension-host pack (unchanged target)
  webview/
    vite.config.ts                      # SPA build → dist/webview/chat/
    chat/
      index.html
  .vscodeignore                         # keep dist/webview/**
  src/
    extension.ts                        # register ChatWebviewViewProvider
    session/
      serverSession.ts                  # pure: resolve external URLs from handle
      serverSession.test.ts
    ui/
      webviewHtml.ts                    # pure: CSP + bootstrap script + asset URIs
      webviewHtml.test.ts
    webview/
      chatViewProvider.ts               # WebviewViewProvider (only vscode import besides extension.ts)
  scripts/
    smokeChatWebview.ts                 # headless: bundle + supervisor + fetch descriptor (optional WS probe)
```

Responsibilities:

- **`bridge.ts`** — minimal Phase-2 bridge surface (`getLocalEnvironmentBootstrap` only); Phase 4 extends via the same global or a sibling native-bridge channel.
- **`chatShell.tsx`** — everything the webview React tree needs below `ChatView`: auth gate, environment connection service, server welcome → active thread ref, reconnect/error surfaces.
- **`webviewHtml.ts`** — testable HTML assembly; extension host passes `asWebviewUri` results and a cryptographically random CSP nonce.
- **`serverSession.ts`** — glue between `supervisor.getHandle()` and `resolveExternalBaseUrls`.
- **`chatViewProvider.ts`** — VSCode API: `resolveWebviewView`, `retainContextWhenHidden`, rebuild HTML when session changes after restart.

---

## Task 1: `isVSCode`, `VsCodeBridge`, and primary environment target/auth

**Files:**

- Create: `apps/web/src/vscode/bridge.ts`
- Modify: `apps/web/src/env.ts`
- Modify: `apps/web/src/vite-env.d.ts`
- Modify: `apps/web/src/environments/primary/target.ts`
- Modify: `apps/web/src/environments/primary/auth.ts`
- Test: `apps/web/src/environments/primary/target.test.ts` (extend existing bootstrap tests)

**Interfaces:**

- Consumes: `DesktopEnvironmentBootstrap` type from `@t3tools/contracts`.
- Produces:
  - `export interface VsCodeBridge { getLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null }`
  - `export function readVsCodeBridge(): VsCodeBridge | null`
  - `export const isVSCode: boolean` — `typeof window !== "undefined" && window.vscodeBridge !== undefined`
  - Updated `readPrimaryEnvironmentTarget()` — prepends `resolveVsCodePrimaryTarget()` before desktop/configured/window-origin (returns `{ source: "vscode-managed", target: { httpBaseUrl, wsBaseUrl } }`).
  - Updated `getDesktopBootstrapCredential()` in `auth.ts` — also reads `window.vscodeBridge?.getLocalEnvironmentBootstrap()?.bootstrapToken`.

- [ ] **Step 1: Write the failing test** — append to `apps/web/src/environments/primary/target.test.ts`:

```ts
it("uses vscodeBridge bootstrap urls when present", () => {
  vi.stubGlobal("window", {
    location: { origin: "https://file+.vscode-resource.vscode-cdn.net/" },
    desktopBridge: undefined,
    vscodeBridge: {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "https://abc-3801.vscode-cdn.example/",
        wsBaseUrl: "wss://abc-3801.vscode-cdn.example/",
        bootstrapToken: "vscode-bootstrap-token",
      }),
    },
  });

  expect(readPrimaryEnvironmentTarget()).toEqual({
    source: "vscode-managed",
    target: {
      httpBaseUrl: "https://abc-3801.vscode-cdn.example/",
      wsBaseUrl: "wss://abc-3801.vscode-cdn.example/",
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm test src/environments/primary/target.test.ts`
Expected: FAIL — `source: "vscode-managed"` not returned (falls through to window-origin).

- [ ] **Step 3: Implement bridge + target + auth**

`apps/web/src/vscode/bridge.ts`:

```ts
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";

export interface VsCodeBridge {
  getLocalEnvironmentBootstrap(): DesktopEnvironmentBootstrap | null;
}

export const readVsCodeBridge = (): VsCodeBridge | null => {
  if (typeof window === "undefined") return null;
  return window.vscodeBridge ?? null;
};
```

`apps/web/src/env.ts` — append:

```ts
export const isVSCode = typeof window !== "undefined" && window.vscodeBridge !== undefined;
```

`apps/web/src/vite-env.d.ts` — add to `Window`:

```ts
    vscodeBridge?: import("./vscode/bridge.ts").VsCodeBridge;
```

`apps/web/src/environments/primary/target.ts` — add:

```ts
import { readVsCodeBridge } from "../../vscode/bridge.ts";

function resolveVsCodePrimaryTarget(): PrimaryEnvironmentTarget | null {
  const bootstrap = readVsCodeBridge()?.getLocalEnvironmentBootstrap() ?? null;
  if (!bootstrap?.httpBaseUrl || !bootstrap.wsBaseUrl) return null;
  return {
    source: "vscode-managed",
    target: {
      httpBaseUrl: normalizeBaseUrl(bootstrap.httpBaseUrl),
      wsBaseUrl: normalizeBaseUrl(bootstrap.wsBaseUrl),
    },
  };
}
```

Update `readPrimaryEnvironmentTarget()`:

```ts
export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget | null {
  return (
    resolveVsCodePrimaryTarget() ??
    resolveDesktopPrimaryTarget() ??
    resolveConfiguredPrimaryTarget() ??
    resolveWindowOriginPrimaryTarget()
  );
}
```

`apps/web/src/environments/primary/auth.ts` — replace `getDesktopBootstrapCredential`:

```ts
function getEmbeddedBootstrapCredential(): string | null {
  const bootstrap =
    window.vscodeBridge?.getLocalEnvironmentBootstrap() ??
    window.desktopBridge?.getLocalEnvironmentBootstrap() ??
    null;
  return typeof bootstrap?.bootstrapToken === "string" && bootstrap.bootstrapToken.length > 0
    ? bootstrap.bootstrapToken
    : null;
}
```

Rename all call sites of `getDesktopBootstrapCredential` → `getEmbeddedBootstrapCredential`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm test src/environments/primary/target.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/vscode/bridge.ts apps/web/src/env.ts apps/web/src/vite-env.d.ts \
  apps/web/src/environments/primary/target.ts apps/web/src/environments/primary/auth.ts \
  apps/web/src/environments/primary/target.test.ts
git commit -m "feat(web): add vscodeBridge bootstrap target for embedded VSCode webviews"
```

---

## Task 2: `@t3tools/web` exports + `VsCodeChatShell`

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/src/vscode/chatShell.tsx`
- Create: `apps/web/src/vscode/main.tsx`
- Test: `apps/web/src/vscode/chatShell.test.tsx`

**Interfaces:**

- Consumes: Task 1 bridge/target/auth; `ChatView`; `startEnvironmentConnectionService`, `ensureEnvironmentConnectionBootstrapped` from `~/environments/runtime`; `ensurePrimaryEnvironmentReady`, `resolveInitialServerAuthGateState`, `updatePrimaryEnvironmentDescriptor` from `~/environments/primary`; `useServerWelcomeSubscription`, `startServerStateSync`, `getPrimaryEnvironmentConnection` from `~/rpc/serverState`; `WebSocketConnectionCoordinator`, `WebSocketConnectionSurface`, `SlowRpcAckToastCoordinator` from `~/components/WebSocketConnectionSurface`; `ToastProvider`, `AnchoredToastProvider` from `~/components/ui/toast`; `AppAtomRegistryProvider` from `~/rpc/atomRegistry`.
- Produces:
  - `export function VsCodeChatShell(): JSX.Element`
  - `export function mountVsCodeChatShell(root: HTMLElement): void` from `main.tsx`
  - Package exports:
    ```json
    "./vscode/chatShell": "./src/vscode/chatShell.tsx",
    "./vscode/main": "./src/vscode/main.tsx"
    ```

- [ ] **Step 1: Write the failing test** — `apps/web/src/vscode/chatShell.test.tsx`

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VsCodeChatShell } from "./chatShell.tsx";

vi.mock("../environments/primary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../environments/primary")>();
  return {
    ...actual,
    resolveInitialServerAuthGateState: vi.fn(async () => ({ status: "authenticated" as const })),
    ensurePrimaryEnvironmentReady: vi.fn(async () => ({
      environmentId: "environment-local",
      label: "Local",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    })),
  };
});

describe("VsCodeChatShell", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      vscodeBridge: {
        getLocalEnvironmentBootstrap: () => ({
          label: "Local",
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          bootstrapToken: "tok",
        }),
      },
      location: {
        href: "https://file+.vscode-resource.vscode-cdn.net/index.html",
        origin: "https://file+.vscode-resource.vscode-cdn.net",
      },
      history: { replaceState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      },
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a connecting state before auth bootstrap completes", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <VsCodeChatShell />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/connecting/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm test src/vscode/chatShell.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Add exports to `apps/web/package.json`**

```json
  "exports": {
    "./vscode/chatShell": "./src/vscode/chatShell.tsx",
    "./vscode/main": "./src/vscode/main.tsx"
  },
```

- [ ] **Step 4: Implement `chatShell.tsx` and `main.tsx`**

`apps/web/src/vscode/chatShell.tsx` (core structure — implement fully, not stubbed):

```tsx
import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatView from "../components/ChatView.tsx";
import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface.tsx";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  ensureEnvironmentConnectionBootstrapped,
  startEnvironmentConnectionService,
} from "../environments/runtime/index.ts";
import {
  ensurePrimaryEnvironmentReady,
  resolveInitialServerAuthGateState,
  updatePrimaryEnvironmentDescriptor,
} from "../environments/primary/index.ts";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry.tsx";
import {
  getPrimaryEnvironmentConnection,
  startServerStateSync,
  useServerWelcomeSubscription,
} from "../rpc/serverState.ts";
import { useStore } from "../store.ts";
import { isVSCode } from "../env.ts";

import "../index.css";

type BootPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; threadRef: ScopedThreadRef | null };

function VsCodeChatShellInner() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<BootPhase>({ kind: "loading" });

  useEffect(() => {
    if (!isVSCode) {
      setPhase({
        kind: "error",
        message: "T3 Code chat shell requires the VSCode webview bridge.",
      });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [, authGate] = await Promise.all([
          ensurePrimaryEnvironmentReady(),
          resolveInitialServerAuthGateState(),
        ]);
        if (cancelled) return;
        if (authGate.status !== "authenticated") {
          setPhase({ kind: "error", message: "Server auth bootstrap failed." });
          return;
        }
        setPhase({ kind: "ready", threadRef: null });
      } catch (error) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return startEnvironmentConnectionService(queryClient);
  }, [queryClient]);

  useEffect(() => {
    return startServerStateSync(getPrimaryEnvironmentConnection().client.server);
  }, []);

  useServerWelcomeSubscription((payload) => {
    if (!payload?.bootstrapThreadId) return;
    updatePrimaryEnvironmentDescriptor(payload.environment);
    useStore.getState().setActiveEnvironmentId(payload.environment.environmentId);
    void ensureEnvironmentConnectionBootstrapped(payload.environment.environmentId).then(() => {
      setPhase({
        kind: "ready",
        threadRef: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId!,
        },
      });
    });
  });

  if (phase.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Connecting to T3 Code…
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-[var(--vscode-errorForeground,var(--color-red-500))]">
          {phase.message}
        </p>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!phase.threadRef) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Waiting for session…
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-hidden bg-background text-foreground">
      <ChatView
        environmentId={phase.threadRef.environmentId}
        threadId={phase.threadRef.threadId}
        routeKind="server"
      />
    </div>
  );
}

export function VsCodeChatShell() {
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <AppAtomRegistryProvider>
        <ToastProvider>
          <AnchoredToastProvider>
            <WebSocketConnectionCoordinator />
            <SlowRpcAckToastCoordinator />
            <WebSocketConnectionSurface>
              <VsCodeChatShellInner />
            </WebSocketConnectionSurface>
          </AnchoredToastProvider>
        </ToastProvider>
      </AppAtomRegistryProvider>
    </QueryClientProvider>
  );
}
```

`apps/web/src/vscode/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { VsCodeChatShell } from "./chatShell.tsx";

export function mountVsCodeChatShell(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <VsCodeChatShell />
    </StrictMode>,
  );
}

const root = document.getElementById("root");
if (root) {
  mountVsCodeChatShell(root);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && pnpm test src/vscode/chatShell.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/vscode/
git commit -m "feat(web): add VsCodeChatShell for embedded VSCode chat webview"
```

---

## Task 3: Webview Vite build target

**Files:**

- Create: `apps/vscode/webview/vite.config.ts`
- Create: `apps/vscode/webview/chat/index.html`
- Modify: `apps/vscode/package.json`
- Modify: `apps/vscode/vite.config.ts` (run.tasks `build` depends on webview build)

**Interfaces:**

- Consumes: `@t3tools/web/vscode/main` entry.
- Produces: `apps/vscode/dist/webview/chat/index.html` + hashed assets; script `"build:webview": "vp build --config webview/vite.config.ts"`.

- [ ] **Step 1: Write `apps/vscode/webview/chat/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>T3 Code</title>
  </head>
  <body class="h-full min-h-0 overflow-hidden">
    <div id="root" class="h-full min-h-0"></div>
    <script type="module" src="../../../web/src/vscode/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `apps/vscode/webview/vite.config.ts`**

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(dir, "../../web/src");

export default defineConfig({
  root: path.join(dir, "chat"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "~": webSrc,
    },
  },
  build: {
    outDir: path.join(dir, "../dist/webview/chat"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
```

- [ ] **Step 3: Update `apps/vscode/package.json`**

Add workspace deps:

```json
  "dependencies": {
    "@t3tools/contracts": "workspace:*",
    "@t3tools/web": "workspace:*"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@vitejs/plugin-react": "^6.0.0",
    "tailwindcss": "^4.0.0",
    "vite": "catalog:"
  },
  "scripts": {
    "build:webview": "vp build --config webview/vite.config.ts",
    "vscode:prepublish": "vp pack && pnpm run build:webview && pnpm run stage:server"
  }
```

- [ ] **Step 4: Update root `apps/vscode/vite.config.ts` run.tasks**

```ts
build: {
  command: "vp pack && pnpm run build:webview",
  dependsOn: ["t3#build", "t3-code#build:webview"],
  cache: false,
},
```

Add a `build:webview` task entry if the monorepo task graph requires it:

```ts
"build:webview": { command: "vp build --config webview/vite.config.ts", cache: false },
```

- [ ] **Step 5: Install + verify build**

Run: `pnpm install && pnpm --filter t3-code build:webview`
Expected: `dist/webview/chat/index.html` and `assets/*.js` exist.

- [ ] **Step 6: Commit**

```bash
git add apps/vscode/webview apps/vscode/package.json apps/vscode/vite.config.ts pnpm-lock.yaml
git commit -m "feat(vscode): add Vite webview bundle build for chat shell"
```

---

## Task 4: Pure webview HTML builder (CSP + bootstrap injection)

**Files:**

- Create: `apps/vscode/src/ui/webviewHtml.ts`
- Test: `apps/vscode/src/ui/webviewHtml.test.ts`

**Interfaces:**

- Consumes: `DesktopEnvironmentBootstrap`-shaped bootstrap object.
- Produces:

  ```ts
  export interface WebviewBootstrapPayload {
    readonly label: string;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly bootstrapToken: string;
  }
  export interface RenderWebviewHtmlInput {
    readonly nonce: string;
    readonly bootstrap: WebviewBootstrapPayload;
    readonly scriptUri: string; // already asWebviewUri'd
    readonly styleUris: readonly string[];
    readonly connectSrcOrigins: readonly string[]; // http + ws origins for CSP
  }
  export function renderWebviewHtml(input: RenderWebviewHtmlInput): string;
  export function buildConnectSrcOrigins(httpBaseUrl: string, wsBaseUrl: string): string[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vite-plus/test";

import { buildConnectSrcOrigins, renderWebviewHtml } from "./webviewHtml.ts";

describe("renderWebviewHtml", () => {
  it("injects vscodeBridge bootstrap and CSP connect-src for ws/http", () => {
    const html = renderWebviewHtml({
      nonce: "abc123",
      bootstrap: {
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3801",
        wsBaseUrl: "ws://127.0.0.1:3801",
        bootstrapToken: "tok",
      },
      scriptUri: "https://file+.vscode-resource.vscode-cdn.net/dist/webview/chat/assets/index.js",
      styleUris: [],
      connectSrcOrigins: buildConnectSrcOrigins("http://127.0.0.1:3801", "ws://127.0.0.1:3801"),
    });
    expect(html).toContain("vscodeBridge");
    expect(html).toContain("tok");
    expect(html).toContain("connect-src");
    expect(html).toContain("ws://127.0.0.1:3801");
    expect(html).toContain("nonce-abc123");
    expect(html).not.toContain("<script>alert");
  });

  it("escapes bootstrap json for inline injection", () => {
    const html = renderWebviewHtml({
      nonce: "n",
      bootstrap: {
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:1",
        wsBaseUrl: "ws://127.0.0.1:1",
        bootstrapToken: "</script>",
      },
      scriptUri: "https://example/vscode-resource/index.js",
      styleUris: [],
      connectSrcOrigins: ["http://127.0.0.1:1", "ws://127.0.0.1:1"],
    });
    expect(html).not.toContain("</script><script");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd apps/vscode && pnpm test src/ui/webviewHtml.test.ts`

- [ ] **Step 3: Implement `webviewHtml.ts`**

Use `JSON.stringify` for bootstrap in an inline script assigning `window.vscodeBridge = { getLocalEnvironmentBootstrap: () => ({...}) }`. CSP template:

```
default-src 'none';
img-src ${cspSource} https: data:;
font-src ${cspSource};
style-src ${cspSource} 'unsafe-inline';
script-src 'nonce-${nonce}';
connect-src ${connectSrcOrigins.join(" ")} ${cspSource};
```

Include `body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }`.

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/vscode/src/ui/webviewHtml.ts apps/vscode/src/ui/webviewHtml.test.ts
git commit -m "feat(vscode): add webview HTML builder with CSP and bootstrap injection"
```

---

## Task 5: Server session resolver (extension host)

**Files:**

- Create: `apps/vscode/src/session/serverSession.ts`
- Test: `apps/vscode/src/session/serverSession.test.ts`

**Interfaces:**

- Consumes: `resolveExternalBaseUrls` from `../transport/urlResolver.ts`.
- Produces:

  ```ts
  export interface ResolvedServerSession {
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly bootstrapToken: string;
    readonly label: string;
  }
  export async function resolveServerSession(input: {
    readonly localHttpBaseUrl: string;
    readonly bootstrapToken: string;
    readonly label?: string;
    readonly asExternalUri: (url: string) => Promise<string>;
  }): Promise<ResolvedServerSession>;
  ```

- [ ] **Step 1: Write failing test** (mock `asExternalUri` identity + forwarded cases — mirror `urlResolver.test.ts`).

- [ ] **Step 2–4: Implement, run tests, PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(vscode): resolve external server session for webview bootstrap"
```

---

## Task 6: `ChatWebviewViewProvider`

**Files:**

- Create: `apps/vscode/src/webview/chatViewProvider.ts`
- Modify: `apps/vscode/src/extension.ts`

**Interfaces:**

- Consumes: `resolveServerSession`, `renderWebviewHtml`, `buildConnectSrcOrigins`; supervisor `getHandle()`; `Logger`.
- Produces:

  ```ts
  export interface ChatViewProviderDeps {
    readonly logger: Logger;
    readonly extensionUri: vscode.Uri;
    readonly getSession: () => Promise<ResolvedServerSession | null>;
    readonly randomBytes: (n: number) => Buffer;
  }
  export class ChatWebviewViewProvider implements vscode.WebviewViewProvider {
    resolveWebviewView(webviewView: vscode.WebviewView): void;
    refresh(): Promise<void>;
  }
  ```

- [ ] **Step 1: Implement provider**

Key behaviors:

- `webview.options = { enableScripts: true, localResourceRoots: [Uri.joinPath(extensionUri, "dist/webview/chat")] }`
- `retainContextWhenHidden = true`
- On resolve/refresh: `getSession()` → if null, set HTML error panel ("Server starting…" with meta refresh or message to retry); else build bootstrap payload, locate `dist/webview/chat/assets/index-*.js` (use `readdirSync` + stable helper `resolveWebviewEntryAsset(extensionUri): { scriptUri, styleUris }`), call `renderWebviewHtml`, assign `webview.html`.
- Subscribe to supervisor restart: extension calls `provider.refresh()` when handle changes (wire in Task 7).

- [ ] **Step 2: Typecheck**

Run: `cd apps/vscode && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(vscode): add ChatWebviewViewProvider for live chat surface"
```

---

## Task 7: Manifest contributions + extension wiring

**Files:**

- Modify: `apps/vscode/package.json` (`contributes.viewsContainers`, `views`, optional command)
- Modify: `apps/vscode/src/extension.ts`
- Modify: `apps/vscode/.vscodeignore` (ensure `!dist/webview/**` is packaged — do **not** ignore `dist/webview`)
- Modify: `apps/vscode/README.md`

**Interfaces:**

- Produces: Activity bar container `t3code` with view `t3code.chat` titled **T3 Code: Chat**; auto-reveal on first successful server start (optional `vscode.commands.executeCommand("t3code.chat.focus")`).

- [ ] **Step 1: Add manifest contributions**

```json
"viewsContainers": {
  "activitybar": [
    {
      "id": "t3code",
      "title": "T3 Code",
      "icon": "media/t3code.svg"
    }
  ]
},
"views": {
  "t3code": [
    {
      "type": "webview",
      "id": "t3code.chat",
      "name": "Chat"
    }
  ]
}
```

Add `media/t3code.svg` (simple monogram; 24×24, currentColor-friendly).

- [ ] **Step 2: Wire `extension.ts`**

After supervisor starts successfully:

1. Build `ChatWebviewViewProvider` with `getSession` reading `supervisor.getHandle()` + `resolveServerSession` + `vscode.env.asExternalUri`.
2. `context.subscriptions.push(vscode.window.registerWebviewViewProvider("t3code.chat", provider))`.
3. On supervisor `start()` resolution (and after restarts via supervisor callback if added, or poll `getHandle()` in provider refresh on visibility), call `provider.refresh()`.

Keep existing `t3code.showStatus` command.

- [ ] **Step 3: Update README** with F5 steps: open **T3 Code: Chat** view → wait for thread → send a message.

- [ ] **Step 4: Build full package**

Run: `pnpm build:server && pnpm --filter t3-code build && pnpm --filter t3-code build:webview`
Expected: `dist/extension.cjs` + `dist/webview/chat/**`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(vscode): register chat webview view and wire server session bootstrap"
```

---

## Task 8: VSIX packaging + headless smoke

**Files:**

- Create: `apps/vscode/scripts/smokeChatWebview.ts`
- Modify: `apps/vscode/package.json` (`smoke-test` runs both smokes or add `smoke-chat-webview`)
- Modify: `apps/vscode/scripts/smokeSupervisor.ts` (optional: export shared spawn helper — only if duplication hurts)

**Interfaces:**

- Produces: script that builds webview, asserts `index.html` + entry asset exist, spawns supervisor headlessly, resolves session URLs, verifies descriptor fetch — mirrors Phase 1 smoke pattern.

- [ ] **Step 1: Write `smokeChatWebview.ts`**

Minimum checks:

1. `dist/webview/chat/index.html` exists after `build:webview`.
2. Headless supervisor reaches ready (reuse smokeSupervisor patterns).
3. `resolveServerSession` returns ws/http URLs; `fetch(readinessUrl)` OK.
4. Parse built `index.html` / entry JS for `VsCodeChatShell` symbol (string grep) to catch empty bundles.

- [ ] **Step 2: Run smokes**

Run: `pnpm --filter t3-code smoke-test && node apps/vscode/scripts/smokeChatWebview.ts`
Expected: PASS.

- [ ] **Step 3: Run repo verification**

Run: `vp check && vp run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "test(vscode): add chat webview smoke and include bundle in VSIX prepublish"
```

---

## Task 9: Manual acceptance (Phase 2 deliverable)

This is the Phase 2 acceptance test — real VSCode APIs + real server + real webview WS.

- [ ] **Step 1: Build artifacts**

Run: `pnpm build:server && pnpm --filter t3-code build && pnpm --filter t3-code build:webview`

- [ ] **Step 2: F5 Extension Development Host**

Open repo → **Run Extension**. Confirm output channel: `Server ready at http://127.0.0.1:<port>`.

- [ ] **Step 3: Open chat webview**

Activity bar → **T3 Code** → **Chat**. Confirm:

- No CSP/connect errors in **Help → Toggle Developer Tools** (webview devtools).
- Transitions from "Connecting…" → chat UI (server welcome provides `bootstrapThreadId` when a workspace folder is open).

- [ ] **Step 4: Send a message**

Type a prompt in the composer → send → confirm assistant turn streams/appears (same as web app).

- [ ] **Step 5: Restart resilience (light)**

Kill server child (`kill <pid>` from output log) → supervisor restarts → chat webview recovers (refresh or auto-reconnect via `client-runtime` — confirm no permanent blank state).

- [ ] **Step 6: VSIX spot check**

Run: `pnpm --filter t3-code package:vsix`
Install VSIX in a clean VSCode → repeat steps 3–4.

- [ ] **Step 7: Record results**

Document pass/fail in PR description. **Remote-SSH repeat (steps 3–4)** — optional if host available (same as Phase 1 Step 7.8).

- [ ] **Step 8: Final commit (if acceptance fixes needed)**

```bash
git commit -m "fix(vscode): phase 2 chat webview acceptance fixes"
```

---

## Phase 2 Self-Review

- **Spec coverage (Phase 2 slice):** second build target (Vite webview bundle) ✓ Tasks 3–4; `isVSCode` runtime flag ✓ Task 1; `@t3tools/web` exports ✓ Task 2; bootstrap injection + WS transport via client-runtime ✓ Tasks 1–2, 4; `ChatView` surface #2 in sidebar webview ✓ Tasks 2, 6–7; CSP `connect-src` includes resolved origin ✓ Task 4; local + Remote-SSH via `asExternalUri` ✓ Tasks 5–7. Deferred correctly: selection broker, remaining webviews, native bridge, full re-theme.
- **No-dependency-on-desktop:** honored — vscodeBridge is a separate minimal global; no `apps/desktop/**` imports.
- **Placeholder scan:** none — each task names concrete files, tests, and commands.
- **Type consistency:** `WebviewBootstrapPayload` fields align with `DesktopEnvironmentBootstrap`; `ResolvedServerSession.bootstrapToken` matches supervisor `ServerHandle.token`.

---

## Roadmap — Phases 3–4 (unchanged; separate plans)

### Phase 3 — Remaining webviews + selection broker

Surfaces #1, #3, #4; extension-host broker; full VSCode CSS-token re-theme.

### Phase 4 — Native bridge

`postMessage` → VSCode APIs for secrets, pickers, terminals, `showTextDocument`, etc.
