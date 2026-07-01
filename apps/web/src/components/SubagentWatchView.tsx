import { createRef, useEffect, useMemo } from "react";
import { type EnvironmentId, MessageId, RuntimeItemId, type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import type { LegendListRef } from "@legendapp/list/react";
import {
  retainSubagentActivitiesSubscription,
  retainSubagentTreeSubscription,
} from "../environments/runtime/service";
import { createSubagentActivitiesSelector, createSubagentRefsSelector } from "../storeSelectors";
import { useStore } from "../store";
import {
  deriveSubagentMessages,
  deriveTimelineEntries,
  deriveWorkLogEntries,
} from "../session-logic";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import type { ChatMessage, TurnDiffSummary } from "../types";
import type { TimestampFormat } from "@t3tools/contracts/settings";

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
    return retainSubagentTreeSubscription(environmentId, threadId);
  }, [environmentId, threadId]);

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

  // The subagent's narrative text (assistant_message / reasoning) is ingested as nested
  // work-log activities; lift it into message bubbles so the transcript reads like a
  // session, and keep only the tool activities in the work log.
  const subagentMessages = useMemo(() => deriveSubagentMessages(activities), [activities]);
  const toolActivities = useMemo(
    () =>
      activities.filter((activity) => {
        const itemType =
          activity.payload && typeof activity.payload === "object"
            ? (activity.payload as Record<string, unknown>).itemType
            : undefined;
        return itemType !== "assistant_message" && itemType !== "reasoning";
      }),
    [activities],
  );
  const workLogEntries = useMemo(() => deriveWorkLogEntries(toolActivities), [toolActivities]);

  // Frame the transcript with the prompt the parent dispatched (first, as a user
  // message) and the text the subagent returned to its parent (last, as an assistant
  // message). The returned text is skipped when it just repeats the final streamed
  // message, to avoid showing the same text twice.
  const timelineMessages = useMemo<ChatMessage[]>(() => {
    const framed: ChatMessage[] = [];
    if (subagentRef?.prompt) {
      framed.push({
        id: MessageId.make(`${subagentRootItemId}:prompt`),
        role: "user",
        text: subagentRef.prompt,
        createdAt: subagentRef.createdAt,
        streaming: false,
      });
    }
    framed.push(...subagentMessages);
    const resultText = subagentRef?.resultText?.trim();
    if (resultText && resultText !== subagentMessages.at(-1)?.text.trim()) {
      framed.push({
        id: MessageId.make(`${subagentRootItemId}:result`),
        role: "assistant",
        text: resultText,
        createdAt: subagentRef?.updatedAt ?? subagentRef?.createdAt ?? "",
        streaming: false,
      });
    }
    return framed;
  }, [subagentRef, subagentMessages, subagentRootItemId]);

  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, EMPTY_PLANS, workLogEntries),
    [timelineMessages, workLogEntries],
  );

  const routeThreadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));

  const isFinished = subagentRef != null && subagentRef.status !== "inProgress";

  // Cross-provider subagents (spawned via `spawn_agent`) carry the provider + model
  // they ran on; native same-thread subagents (Task/Agent + Workflow agents) carry just
  // the model. Show whichever is present at the top of the transcript — with no provider
  // the label collapses to the model alone, and with neither it's omitted entirely.
  const providerLabel = subagentRef?.provider ?? subagentRef?.providerInstanceId ?? null;
  const providerModelLabel =
    [providerLabel, subagentRef?.model ?? null].filter((part) => part !== null).join(" · ") || null;

  const listRef = useMemo(() => createRef<LegendListRef | null>(), []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium text-muted-foreground">
          Subagent:{" "}
          <span className="text-foreground">{subagentRef?.subagentType ?? "unknown"}</span>
        </div>
        {providerModelLabel !== null && (
          <div
            data-testid="subagent-provider-model"
            className="mt-1 text-xs font-medium text-muted-foreground"
          >
            {providerModelLabel}
          </div>
        )}
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
          backgroundWork={null}
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
