import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ScopedThreadRef,
  ServerLifecycleWelcomePayload,
} from "@t3tools/contracts";

import ChatView from "../components/ChatView";
import { Button } from "../components/ui/button";
import { SidebarProvider } from "../components/ui/sidebar";
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
import { startServerStateSync, useServerWelcomeSubscription } from "../rpc/serverState";
import { useStore } from "../store";
import { isVSCode } from "../env";

import { VsCodeActiveThreadRefContext } from "./activeThreadContext";

type BootPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; threadRef: ScopedThreadRef | null };

export function markVsCodeShellAuthenticated(phase: BootPhase): BootPhase {
  if (phase.kind === "ready" && phase.threadRef) {
    return phase;
  }
  return { kind: "ready", threadRef: null };
}

export function handleVsCodeWelcomePayload(input: {
  readonly payload: ServerLifecycleWelcomePayload;
  readonly updateEnvironmentDescriptor: (descriptor: ExecutionEnvironmentDescriptor) => void;
  readonly setActiveEnvironmentId: (environmentId: EnvironmentId) => void;
  readonly ensureBootstrapped: (environmentId: EnvironmentId) => Promise<void>;
  readonly setThreadRef: (threadRef: ScopedThreadRef) => void;
}): void {
  const bootstrapThreadId = input.payload.bootstrapThreadId;
  if (!bootstrapThreadId) {
    return;
  }

  const environmentId = input.payload.environment.environmentId;
  input.updateEnvironmentDescriptor(input.payload.environment);
  input.setActiveEnvironmentId(environmentId);
  input.setThreadRef({
    environmentId,
    threadId: bootstrapThreadId,
  });
  void input.ensureBootstrapped(environmentId).catch(() => undefined);
}

export function VsCodeChatShellInner() {
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
          setPhase({
            kind: "error",
            message:
              authGate.status === "requires-auth" && authGate.errorMessage
                ? authGate.errorMessage
                : "Server auth bootstrap failed.",
          });
          return;
        }
        setPhase(markVsCodeShellAuthenticated);
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
    handleVsCodeWelcomePayload({
      payload,
      updateEnvironmentDescriptor: updatePrimaryEnvironmentDescriptor,
      setActiveEnvironmentId: useStore.getState().setActiveEnvironmentId,
      ensureBootstrapped: ensureEnvironmentConnectionBootstrapped,
      setThreadRef: (threadRef) => {
        setPhase({
          kind: "ready",
          threadRef,
        });
      },
    });
  });

  const activeThreadRef = phase.kind === "ready" ? phase.threadRef : null;

  let content: ReactNode;
  if (phase.kind === "loading") {
    content = (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Connecting to T3 Code…
      </div>
    );
  } else if (phase.kind === "error") {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-[var(--vscode-errorForeground,var(--color-red-500))]">
          {phase.message}
        </p>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  } else if (!phase.threadRef) {
    content = (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Waiting for session…
      </div>
    );
  } else {
    // ChatView's header renders a SidebarTrigger, so it (and any descendant)
    // calls useSidebar() unconditionally. The embedded chat shell has no app
    // sidebar, but the context must still exist or the subtree throws
    // "useSidebar must be used within a SidebarProvider". min-h-0! overrides the
    // provider's default min-h-svh so the chat fills the VS Code panel instead.
    content = (
      <SidebarProvider
        defaultOpen={false}
        className="h-full min-h-0! w-full overflow-hidden bg-background text-foreground"
      >
        <ChatView
          environmentId={phase.threadRef.environmentId}
          threadId={phase.threadRef.threadId}
          routeKind="server"
        />
      </SidebarProvider>
    );
  }

  return (
    <VsCodeActiveThreadRefContext.Provider value={activeThreadRef}>
      {content}
    </VsCodeActiveThreadRefContext.Provider>
  );
}
