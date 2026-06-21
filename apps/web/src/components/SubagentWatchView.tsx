import { createRef, useEffect, useMemo } from "react";
import {
  type EnvironmentId,
  type MessageId,
  RuntimeItemId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import type { LegendListRef } from "@legendapp/list/react";
import { retainSubagentActivitiesSubscription } from "../environments/runtime/service";
import { createSubagentActivitiesSelector, createSubagentRefsSelector } from "../storeSelectors";
import { useStore } from "../store";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../session-logic";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import type { TurnDiffSummary } from "../types";
import type { TimestampFormat } from "@t3tools/contracts/settings";

const EMPTY_MESSAGES: never[] = [];
const EMPTY_PLANS: never[] = [];
const EMPTY_TURN_DIFF_SUMMARIES = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();
const NOOP = () => {};
const TIMESTAMP_FORMAT: TimestampFormat = "locale";

export interface SubagentWatchViewProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  subagentRootItemId: string;
}

export function SubagentWatchView({
  environmentId,
  threadId,
  subagentRootItemId,
}: SubagentWatchViewProps) {
  useEffect(() => {
    return retainSubagentActivitiesSubscription(
      environmentId,
      threadId,
      RuntimeItemId.make(subagentRootItemId),
    );
  }, [environmentId, threadId, subagentRootItemId]);

  const activities = useStore(
    useMemo(
      () => createSubagentActivitiesSelector(environmentId, threadId, subagentRootItemId),
      [environmentId, threadId, subagentRootItemId],
    ),
  );

  const refs = useStore(
    useMemo(() => createSubagentRefsSelector(environmentId, threadId), [environmentId, threadId]),
  );

  const subagentRef = refs.find((r) => r.rootItemId === subagentRootItemId) ?? null;

  const workLogEntries = useMemo(() => deriveWorkLogEntries(activities), [activities]);

  const timelineEntries = useMemo(
    () => deriveTimelineEntries(EMPTY_MESSAGES, EMPTY_PLANS, workLogEntries),
    [workLogEntries],
  );

  const routeThreadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));

  const isFinished = subagentRef != null && subagentRef.status !== "inProgress";

  const listRef = useMemo(() => createRef<LegendListRef | null>(), []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium text-muted-foreground">
          Subagent:{" "}
          <span className="text-foreground">{subagentRef?.subagentType ?? "unknown"}</span>
        </div>
        {subagentRef?.description && (
          <div className="mt-1 text-xs text-muted-foreground">{subagentRef.description}</div>
        )}
      </div>

      {isFinished && (
        <div
          data-testid="subagent-finished-banner"
          className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-sm text-muted-foreground"
        >
          Subagent finished
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <MessagesTimeline
          isWorking={!isFinished}
          activeTurnInProgress={!isFinished}
          activeTurnStartedAt={null}
          listRef={listRef}
          timelineEntries={timelineEntries}
          latestTurn={null}
          turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFF_SUMMARIES}
          routeThreadKey={routeThreadKey}
          onOpenTurnDiff={NOOP}
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
          onRevertUserMessage={NOOP}
          isRevertingCheckpoint={false}
          onImageExpand={NOOP}
          activeThreadEnvironmentId={environmentId}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat={TIMESTAMP_FORMAT}
          workspaceRoot={undefined}
          onIsAtEndChange={NOOP}
        />
      </div>
    </div>
  );
}
