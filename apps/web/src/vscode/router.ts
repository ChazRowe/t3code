import { createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";

import { VsCodeChatShellRoot } from "./chatShellRoot";

const vscodeShellRootRoute = createRootRoute({
  component: VsCodeChatShellRoot,
});

export function createVsCodeShellRouter() {
  return createRouter({
    routeTree: vscodeShellRootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}
