import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatView from "../components/ChatView";
import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { Button } from "../components/ui/button";
import {
  ensureEnvironmentConnectionBootstrapped,
  getPrimaryEnvironmentConnection,
  startEnvironmentConnectionService,
} from "../environments/runtime";
import {
  ensurePrimaryEnvironmentReady,
  resolveInitialServerAuthGateState,
  updatePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  startServerStateSync,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import { useStore } from "../store";
import { isVSCode } from "../env";

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
      setPhase({ kind: "error", message: "T3 Code chat shell requires the VSCode webview bridge." });
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
    if (phase.kind !== "ready") {
      return;
    }
    return startServerStateSync(getPrimaryEnvironmentConnection().client.server);
  }, [phase.kind]);

  useServerWelcomeSubscription((payload) => {
    const bootstrapThreadId = payload.bootstrapThreadId;
    if (!bootstrapThreadId) {
      return;
    }
    updatePrimaryEnvironmentDescriptor(payload.environment);
    useStore.getState().setActiveEnvironmentId(payload.environment.environmentId);
    void ensureEnvironmentConnectionBootstrapped(payload.environment.environmentId).then(() => {
      setPhase({
        kind: "ready",
        threadRef: {
          environmentId: payload.environment.environmentId,
          threadId: bootstrapThreadId,
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
