import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";

import { VsCodeChatShellInner } from "./chatShellInner";

export function VsCodeChatShellRoot() {
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
