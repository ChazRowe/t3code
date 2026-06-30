import { describe, expect, it, vi, beforeEach, afterEach } from "vite-plus/test";
import { renderToString } from "react-dom/server";

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
});
