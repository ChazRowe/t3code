import { useMemo } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, OrchestrationSubagentRef, ThreadId } from "@t3tools/contracts";

import { useStore } from "../../store";
import { createSubagentRefsSelector } from "../../storeSelectors";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { buildSubagentForest, childRefsOf } from "./SidebarSubagentTree.logic";

interface SidebarSubagentTreeProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}

function SubagentStatusDot({ status }: { status: OrchestrationSubagentRef["status"] }) {
  if (status === "inProgress") {
    return (
      <span
        className="size-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-300/80 animate-pulse"
        aria-label="running"
      />
    );
  }
  if (status === "failed" || status === "declined") {
    return <span className="size-1.5 shrink-0 rounded-full bg-red-500" aria-label="error" />;
  }
  return (
    <span
      className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
      aria-label="completed"
    />
  );
}

export function SidebarSubagentTree({ environmentId, threadId }: SidebarSubagentTreeProps) {
  const refs = useStore(
    useMemo(() => createSubagentRefsSelector(environmentId, threadId), [environmentId, threadId]),
  );
  const threadKey = useMemo(
    () => scopedThreadKey(scopeThreadRef(environmentId, threadId)),
    [environmentId, threadId],
  );
  const forest = useMemo(() => buildSubagentForest(refs), [refs]);

  if (refs.length === 0) {
    return null;
  }

  if (forest.kind === "grouped") {
    return (
      <SidebarMenuSub className="mr-0">
        {forest.groups.map((group) => (
          <SubagentIterationNode
            key={`${threadKey}::iter::${group.iteration}`}
            environmentId={environmentId}
            threadId={threadId}
            threadKey={threadKey}
            iteration={group.iteration}
            groupRefs={group.refs}
            allRefs={refs}
          />
        ))}
      </SidebarMenuSub>
    );
  }

  return (
    <SidebarMenuSub className="mr-0">
      {forest.refs.map((ref) => (
        <SubagentNode
          key={`${threadKey}::sa::${ref.rootItemId}`}
          environmentId={environmentId}
          threadId={threadId}
          threadKey={threadKey}
          subagentRef={ref}
          allRefs={refs}
        />
      ))}
    </SidebarMenuSub>
  );
}

function SubagentIterationNode({
  environmentId,
  threadId,
  threadKey,
  iteration,
  groupRefs,
  allRefs,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadKey: string;
  iteration: number;
  groupRefs: OrchestrationSubagentRef[];
  allRefs: OrchestrationSubagentRef[];
}) {
  const key = `${threadKey}::iter::${iteration}`;
  const expanded = useUiStateStore((state) => state.subagentExpandedById[key] ?? false);
  const toggleSubagent = useUiStateStore((state) => state.toggleSubagent);
  const iterationRowRender = useMemo(() => <div role="button" tabIndex={0} />, []);

  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={iterationRowRender}
        size="sm"
        data-testid={`subagent-iteration-${threadId}-${iteration}`}
        className="cursor-pointer outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => toggleSubagent(key)}
      >
        <ChevronRightIcon
          className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/80">
          Iteration {iteration}
        </span>
      </SidebarMenuSubButton>
      {expanded && (
        <SidebarMenuSub className="mr-0">
          {groupRefs.map((ref) => (
            <SubagentNode
              key={`${threadKey}::sa::${ref.rootItemId}`}
              environmentId={environmentId}
              threadId={threadId}
              threadKey={threadKey}
              subagentRef={ref}
              allRefs={allRefs}
            />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuSubItem>
  );
}

function SubagentNode({
  environmentId,
  threadId,
  threadKey,
  subagentRef,
  allRefs,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadKey: string;
  subagentRef: OrchestrationSubagentRef;
  allRefs: OrchestrationSubagentRef[];
}) {
  const navigate = useNavigate();
  // The sidebar renders in the _chat layout (an ancestor of the watch route), so
  // useParams can't see the descendant route's subagentRootItemId — read it off the
  // URL instead so the open subagent highlights as selected.
  const activeSubagentRootItemId = useLocation({
    select: (location) => {
      const encoded = location.pathname.match(/\/subagent\/([^/]+)\/?$/)?.[1];
      return encoded ? decodeURIComponent(encoded) : undefined;
    },
  });
  const isActive = activeSubagentRootItemId === subagentRef.rootItemId;
  const key = `${threadKey}::sa::${subagentRef.rootItemId}`;
  const expanded = useUiStateStore((state) => state.subagentExpandedById[key] ?? false);
  const toggleSubagent = useUiStateStore((state) => state.toggleSubagent);
  const children = useMemo(
    () => childRefsOf(allRefs, subagentRef.rootItemId),
    [allRefs, subagentRef.rootItemId],
  );
  const hasChildren = subagentRef.childSubagentCount > 0 || children.length > 0;
  const subagentRowRender = useMemo(() => <div role="button" tabIndex={0} />, []);

  return (
    <SidebarMenuSubItem className="w-full">
      <SidebarMenuSubButton
        render={subagentRowRender}
        size="sm"
        isActive={isActive}
        data-testid={`subagent-row-${subagentRef.rootItemId}`}
        className={
          isActive
            ? "cursor-pointer bg-primary/22 font-medium text-foreground hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36"
            : "cursor-pointer"
        }
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId/subagent/$subagentRootItemId",
            params: {
              environmentId,
              threadId,
              subagentRootItemId: subagentRef.rootItemId,
            },
          })
        }
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse subagent" : "Expand subagent"}
            className="inline-flex cursor-pointer items-center justify-center outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleSubagent(key);
            }}
          >
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </button>
        ) : (
          <span className="-ml-0.5 size-3.5 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <SubagentStatusDot status={subagentRef.status} />
          <span className="min-w-0 flex-1 truncate text-xs">{subagentRef.subagentType}</span>
          {subagentRef.description && (
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/55">
              {subagentRef.description}
            </span>
          )}
        </span>
      </SidebarMenuSubButton>
      {expanded && hasChildren && (
        <SidebarMenuSub className="mr-0">
          {children.map((child) => (
            <SubagentNode
              key={`${threadKey}::sa::${child.rootItemId}`}
              environmentId={environmentId}
              threadId={threadId}
              threadKey={threadKey}
              subagentRef={child}
              allRefs={allRefs}
            />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuSubItem>
  );
}
