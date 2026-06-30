import { describe, expect, it, vi, beforeEach, afterEach } from "vite-plus/test";
import type React from "react";
import { renderToString } from "react-dom/server";
import { EnvironmentId, ThreadId, type ServerLifecycleWelcomePayload } from "@t3tools/contracts";

import { handleVsCodeWelcomePayload, markVsCodeShellAuthenticated } from "./chatShellInner";

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

vi.mock("../components/ChatView", () => ({
  default: () => null,
}));

vi.mock("../environments/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../environments/runtime")>();
  return {
    ...actual,
    startEnvironmentConnectionService: vi.fn(() => () => {}),
    ensureEnvironmentConnectionBootstrapped: vi.fn(async () => {}),
    getPrimaryEnvironmentConnection: vi.fn(() => ({
      client: { server: {} },
    })),
  };
});

vi.mock("../rpc/serverState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rpc/serverState")>();
  return {
    ...actual,
    startServerStateSync: vi.fn(() => () => {}),
    useServerWelcomeSubscription: vi.fn(() => {}),
  };
});

vi.mock("../components/WebSocketConnectionSurface", () => ({
  WebSocketConnectionCoordinator: () => null,
  SlowRpcAckToastCoordinator: () => null,
  WebSocketConnectionSurface: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../components/ui/toast", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  AnchoredToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { VsCodeChatShellRoot } = await import("./chatShellRoot");
  return {
    ...actual,
    RouterProvider: () => <VsCodeChatShellRoot />,
    createMemoryHistory: vi.fn(() => ({})),
    createRootRoute: vi.fn((opts: { component: React.ComponentType }) => opts),
    createRouter: vi.fn(() => ({})),
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
        reload: vi.fn(),
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
    vi.resetModules();
  });

  it("shows a connecting state before auth bootstrap completes", async () => {
    vi.resetModules();
    const { VsCodeChatShell } = await import("./chatShell");
    const html = renderToString(<VsCodeChatShell />);
    expect(html.toLowerCase()).toContain("connecting");
  });

  it("activates the bootstrapped thread before environment shell hydration finishes", () => {
    const setThreadRef = vi.fn();
    const ensureBootstrapped = vi.fn(() => new Promise<void>(() => {}));
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("thread-vscode-bootstrap");
    const payload = {
      environment: {
        environmentId,
        label: "Local",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      cwd: "/tmp/workspace",
      projectName: "workspace",
      bootstrapThreadId: threadId,
    } satisfies ServerLifecycleWelcomePayload;

    handleVsCodeWelcomePayload({
      payload,
      ensureBootstrapped,
      setThreadRef,
      setActiveEnvironmentId: vi.fn(),
      updateEnvironmentDescriptor: vi.fn(),
    });

    expect(ensureBootstrapped).toHaveBeenCalledWith(environmentId);
    expect(setThreadRef).toHaveBeenCalledWith({ environmentId, threadId });
  });

  it("keeps the bootstrapped thread if auth bootstrap completes after welcome handling", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const threadId = ThreadId.make("thread-vscode-bootstrap");

    expect(
      markVsCodeShellAuthenticated({
        kind: "ready",
        threadRef: { environmentId, threadId },
      }),
    ).toEqual({
      kind: "ready",
      threadRef: { environmentId, threadId },
    });
  });
});
