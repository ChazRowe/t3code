import { createFileRoute } from "@tanstack/react-router";

import { SubagentWatchView } from "../components/SubagentWatchView";
import { resolveThreadRouteRef } from "../threadRoutes";
import { SidebarInset } from "~/components/ui/sidebar";

function SubagentWatchRouteView() {
  const { threadRef, subagentRootItemId } = Route.useParams({
    select: (params) => ({
      threadRef: resolveThreadRouteRef(params),
      subagentRootItemId: params.subagentRootItemId,
    }),
  });

  if (!threadRef) return null;

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <SubagentWatchView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        subagentRootItemId={subagentRootItemId}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute(
  "/_chat/$environmentId/$threadId/subagent/$subagentRootItemId",
)({
  component: SubagentWatchRouteView,
});
